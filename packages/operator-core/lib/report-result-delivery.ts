/** Semantic receipts at the final MCP result boundary, after projection and the door. */
import { createHash } from 'node:crypto';
import type { DoorableResult } from './result-door';
import { parseMcpToolText } from './endpoint-route/routes/transport/mcp-result-text';

export interface DeliveredReportEdition {
  id: string; bodySha256: string; bodyBytes: number; visibility: string; publishedAt: string;
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function bodies(result: DoorableResult): Record<string, unknown>[] {
  if (result.isError || !Array.isArray(result.content)) return [];
  return result.content.flatMap(item => {
    if (item.type !== 'text' || typeof item.text !== 'string') return [];
    try { const value = record(parseMcpToolText(item.text)); return value ? [value] : []; } catch { return []; }
  });
}
function editions(result: DoorableResult): DeliveredReportEdition[] {
  return bodies(result).flatMap(body => (Array.isArray(body.results) ? body.results : []).flatMap(value => {
    const row = record(value), report = record(row?.report);
    if (row?.ok !== true || !report || typeof row.id !== 'string' ||
        typeof report.body_md !== 'string' || typeof report.visibility !== 'string' ||
        typeof report.published_at !== 'string' || !Number.isFinite(Date.parse(report.published_at))) return [];
    const bodySha256 = hash(report.body_md), bodyBytes = Buffer.byteLength(report.body_md, 'utf8');
    if (report.body_sha256 !== bodySha256 || report.body_bytes !== bodyBytes) return [];
    return [{ id: row.id, bodySha256, bodyBytes, visibility: report.visibility, publishedAt: report.published_at }];
  }));
}

/** Only hash-bound JSON spills qualify; an unread or unidentifiable spill proves no delivery. */
export function reportResultDeliveryMetadata(tool: string, source: DoorableResult, delivered: DoorableResult): Record<string, unknown> {
  const deliveredAt = new Date().toISOString();
  if (tool === 'reports:get') {
    const inline = editions(delivered), reports = editions(source);
    const payload = JSON.stringify({ content: source.content, ...(source.isError !== undefined ? { isError: source.isError } : {}) });
    const payloadSha256 = hash(payload), payloadBytes = Buffer.byteLength(payload, 'utf8');
    const refs = bodies(delivered).flatMap(body => Array.isArray(body.content) ? body.content : []);
    const reference = refs.map(record).find(ref => ref && typeof ref.uri === 'string' &&
      ref.sha256 === payloadSha256 && ref.byteCount === payloadBytes);
    return { reportResultDelivery: { version: 1, deliveredAt, inline,
      ...(reference && reports.length ? { spill: { uri: reference.uri, sha256: payloadSha256, bytes: payloadBytes, reports } } : {}) } };
  }
  if (tool === 'capability:read') {
    for (const body of bodies(delivered)) {
      const ref = record(body.reference);
      if (body.ok !== true || body.encoding !== 'base64' || typeof body.data !== 'string' ||
          typeof body.file_path !== 'string' || !body.file_path.startsWith('papercusp://scratch') ||
          typeof ref?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
          !Number.isSafeInteger(body.total_bytes) || body.total_bytes !== ref.byteCount ||
          !Number.isSafeInteger(body.byte_offset) || !Number.isSafeInteger(body.byte_length)) continue;
      const offset = body.byte_offset as number, bytes = body.byte_length as number, totalBytes = body.total_bytes as number;
      const decoded = Buffer.from(body.data, 'base64');
      if (offset < 0 || bytes <= 0 || offset + bytes > totalBytes || decoded.length !== bytes ||
          decoded.toString('base64') !== body.data) continue;
      return { scratchResultDelivery: { version: 1, deliveredAt, uri: body.file_path, sha256: ref.sha256, totalBytes, offset, bytes } };
    }
    return { scratchResultDelivery: null };
  }
  return {};
}

/** Return the actual final delivery time, including every page of a consumed spill. */
export function completeReportDeliveryAt(metadata: Record<string, unknown> | null | undefined,
  report: DeliveredReportEdition, pages: Array<{ status: string; metadata?: Record<string, unknown> | null }>,
  windowStart: number, windowEnd: number): number | null {
  const delivery = record(metadata?.reportResultDelivery);
  if (delivery?.version !== 1 || typeof delivery.deliveredAt !== 'string') return null;
  const at = Date.parse(delivery.deliveredAt);
  if (!Number.isFinite(at) || at < windowStart || at > windowEnd) return null;
  const same = (value: unknown) => {
    const row = record(value);
    return row?.id === report.id && row.bodySha256 === report.bodySha256 && row.bodyBytes === report.bodyBytes &&
      row.visibility === report.visibility && typeof row.publishedAt === 'string' &&
      Date.parse(row.publishedAt) === Date.parse(report.publishedAt);
  };
  if (Array.isArray(delivery.inline) && delivery.inline.some(same)) return at;
  const spill = record(delivery.spill);
  if (!spill || typeof spill.uri !== 'string' || typeof spill.sha256 !== 'string' ||
      !Number.isSafeInteger(spill.bytes) || (spill.bytes as number) <= 0 ||
      !Array.isArray(spill.reports) || !spill.reports.some(same)) return null;
  const ranges = pages.flatMap(page => {
    const read = record(page.metadata?.scratchResultDelivery);
    if (page.status !== 'ok' || page.metadata?.resultOutcome === 'soft-failure' || read?.version !== 1 ||
        read.uri !== spill.uri || read.sha256 !== spill.sha256 || read.totalBytes !== spill.bytes ||
        typeof read.deliveredAt !== 'string' || !Number.isSafeInteger(read.offset) || !Number.isSafeInteger(read.bytes)) return [];
    const time = Date.parse(read.deliveredAt), start = read.offset as number, size = read.bytes as number;
    if (!Number.isFinite(time) || time < at || time > windowEnd || start < 0 || size <= 0 || start + size > (spill.bytes as number)) return [];
    return [{ start, end: start + size, time }];
  }).sort((a, b) => a.start - b.start || a.time - b.time);
  let end = 0, finishedAt = at;
  for (const range of ranges) {
    if (range.start > end) return null;
    if (range.end <= end) continue;
    end = range.end; finishedAt = Math.max(finishedAt, range.time);
    if (end === spill.bytes) return finishedAt;
  }
  return null;
}
