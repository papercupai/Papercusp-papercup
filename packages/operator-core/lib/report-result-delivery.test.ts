import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encode } from '@papercusp/result-encoding';
import { BAKED_DOOR_CONSTANTS } from './context-doors';
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: () => BAKED_DOOR_CONSTANTS }));
import { applyResultDoor, beginResultDoorAggregate, resetResultDoorAggregatesForTests, type DoorableResult } from './result-door';
import { parseScratchReference } from './scratch-reference';
import { completeReportDeliveryAt, reportResultDeliveryMetadata } from './report-result-delivery';

const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const body = 'Complete report é\n', publishedAt = '2026-10-22T00:00:00.000Z';
const edition = { id: 'rpt-test', bodySha256: digest(body), bodyBytes: Buffer.byteLength(body), visibility: 'owner', publishedAt };
const source: DoorableResult = { content: [{ type: 'text', text: JSON.stringify({ ok: true,
  results: [{ ok: true, id: edition.id, report: { body_md: body, body_sha256: edition.bodySha256,
    body_bytes: edition.bodyBytes, visibility: edition.visibility, published_at: publishedAt } }] }) }] };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'report-delivery-'));
  vi.stubEnv('PAPERCUSP_SCRATCH_ROOT', root);
  vi.stubEnv('PAPERCUSP_RESULT_DOOR_OFF', '0');
  resetResultDoorAggregatesForTests();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const complete = (metadata: Record<string, unknown>, pages: Array<{status: string; metadata: Record<string, unknown>}> = []) =>
  completeReportDeliveryAt(metadata, edition, pages, 0, Date.now() + 10_000);

describe('final report result delivery', () => {
  it('records the exact edition after the real inline result door', () => {
    const result = applyResultDoor(source, { toolName: 'reports:get', workspaceId: 'ws-1' });
    const metadata = reportResultDeliveryMetadata('reports:get', source, result);
    expect(metadata).toMatchObject({ reportResultDelivery: { version: 1, inline: [edition] } });
    expect(complete(metadata)).not.toBeNull();
  });
  it('uses the native MCP decoder for a complete TOON report edition', () => {
    const toon = { content: [{ type: 'text', text: `format: toon\n${encode(JSON.parse(source.content[0].text as string), 'toon')}` }] };
    expect(reportResultDeliveryMetadata('reports:get', toon, toon)).toMatchObject({
      reportResultDelivery: { inline: [edition] },
    });
  });
  it.each(['missing-body', 'wrong-hash', 'wrong-bytes', 'error'])(
    'rejects a final result whose handler edition was complete: %s', defect => {
      const result = structuredClone(source);
      const wire = JSON.parse(result.content[0].text as string);
      if (defect === 'missing-body') delete wire.results[0].report.body_md;
      if (defect === 'wrong-hash') wire.results[0].report.body_sha256 = 'b'.repeat(64);
      if (defect === 'wrong-bytes') wire.results[0].report.body_bytes = 1;
      if (defect === 'error') result.isError = true;
      result.content = [{ type: 'text', text: JSON.stringify(wire) }];
      expect(complete(reportResultDeliveryMetadata('reports:get', source, result))).toBeNull();
    });
  it('requires full matching page delivery after a real aggregate-door spill', () => {
    const opts = { toolName: 'reports:get', workspaceId: 'ws-1', ownerId: 'su-test',
      aggregateScope: beginResultDoorAggregate({ sessionKey: 'ws-1:su-test', outputGroupId: 'delivery-test' }) };
    for (let n = 0; n < 3; n++) applyResultDoor({ content: [{ type: 'text', text: 'x'.repeat(6000) }] }, opts);
    const result = applyResultDoor(source, opts);
    const metadata = reportResultDeliveryMetadata('reports:get', source, result);
    expect(metadata).toMatchObject({ reportResultDelivery: { inline: [], spill: { reports: [edition] } } });
    expect(complete(metadata)).toBeNull(); // Handler metadata cannot make an unread spill pass.
    const door = result._meta!.resultDoor as { spillPath: string; spillUri: string };
    const stored = parseScratchReference(readFileSync(door.spillPath));
    if (!stored) throw new Error('Expected a complete scratch-reference payload');
    const pages = [];
    for (let offset = 0; offset < stored.payload.length; offset += 100) {
      const data = stored.payload.subarray(offset, offset + 100);
      const page = { content: [{ type: 'text', text: JSON.stringify({ ok: true, file_path: door.spillUri,
        encoding: 'base64', data: data.toString('base64'), byte_offset: offset, byte_length: data.length,
        total_bytes: stored.payload.length, reference: stored.manifest }) }] };
      const delivered = applyResultDoor(page, { ...opts, toolName: 'capability:read' });
      pages.push({ status: 'ok', metadata: reportResultDeliveryMetadata('capability:read', page, delivered) });
    }
    expect(complete(metadata, pages.slice(1))).toBeNull();
    expect(complete(metadata, pages)).not.toBeNull();
    const foreign = structuredClone(pages);
    for (const page of foreign) (page.metadata.scratchResultDelivery as Record<string, unknown>).sha256 = 'b'.repeat(64);
    expect(complete(metadata, foreign)).toBeNull();
    expect(complete(metadata, pages.map(page => ({ ...page, status: 'error' })))).toBeNull();
  });
  it('does not record a byte page removed by a later projection', () => {
    expect(reportResultDeliveryMetadata('capability:read', source, { content: [] })).toEqual({ scratchResultDelivery: null });
  });
  it.each(['bad-base64', 'partial-bytes', 'missing-reference', 'wrong-total', 'negative-offset', 'outside-payload'])(
    'does not record an invalid final byte page: %s', defect => {
      const page: Record<string, unknown> = { ok: true, file_path: 'papercusp://scratch/page', encoding: 'base64',
        data: 'YWJj', byte_offset: 0, byte_length: 3, total_bytes: 3, reference: { byteCount: 3, sha256: 'b'.repeat(64) } };
      if (defect === 'bad-base64') page.data = 'YWJj!!!!';
      if (defect === 'partial-bytes') page.byte_length = 2;
      if (defect === 'missing-reference') delete page.reference;
      if (defect === 'wrong-total') page.total_bytes = 4;
      if (defect === 'negative-offset') page.byte_offset = -1;
      if (defect === 'outside-payload') page.byte_offset = 1;
      const result = { content: [{ type: 'text', text: JSON.stringify(page) }] };
      expect(reportResultDeliveryMetadata('capability:read', result, result)).toEqual({ scratchResultDelivery: null });
    });
});
