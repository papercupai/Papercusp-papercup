import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../../data-governance/siem-export-delivery', async (importOriginal) => {
  // Keep the real error class and codes; only the operations are replaced.
  const original = await importOriginal<typeof import('../../../data-governance/siem-export-delivery')>();
  return { ...original, siemExportStatus: vi.fn(), siemExportNext: vi.fn(), siemExportAck: vi.fn() };
});

import { SIEM_EXPORT_SCHEMA, SiemExportAccessError } from '../../../data-governance/siem-export';
import {
  SiemExportError,
  siemExportAck,
  siemExportNext,
  siemExportStatus,
  type SiemExportAckResult,
  type SiemExportErrorCode,
  type SiemExportNextResult,
  type SiemExportStatusResult,
  type SiemStreamState,
} from '../../../data-governance/siem-export-delivery';
import { mockResolvedTyped } from '../../../testing/typed-mock';
import routes, { SIEM_EXPORT_STATUS } from './siem-export';

const [statusRoute, nextRoute, ackRoute] = routes;
const KEY = 'a'.repeat(64);

const STREAM: SiemStreamState = {
  streamId: 'papercusp.siem-export:ws-active',
  kind: 'tool-invocations',
  persisted: false,
  cursor: '0',
  head: null,
  keyId: null,
  deliveredBatches: 0,
  updatedAt: null,
};
const NEXT: SiemExportNextResult = {
  manifest: {
    schema: SIEM_EXPORT_SCHEMA,
    streamId: STREAM.streamId,
    cursorFrom: '0',
    cursorTo: '0',
    idempotencyKey: KEY,
    startAfter: null,
    head: null,
    length: 0,
  },
  head: null,
  jsonl: '',
  horizon: { bound: new Date(0), source: 'settle-window', complete: true, settleMs: 600_000, oldestOpenTransactionStart: null },
  stream: STREAM,
  keyRotated: false,
};
const ACK: SiemExportAckResult = {
  status: 'acknowledged',
  delivery: {
    deliveryId: 'd-1',
    idempotencyKey: KEY,
    cursorFrom: '0',
    cursorTo: '9',
    length: 9,
    headSeq: 8,
    headEntryHash: 'b'.repeat(64),
    keyId: 'k:0123456789abcdef',
    acknowledgedBy: 'admin:tester',
    acknowledgedAt: new Date(0).toISOString(),
  },
  stream: STREAM,
  keyRotated: false,
};
const STATUS: SiemExportStatusResult = { stream: STREAM, recentDeliveries: [], configuredKeyId: null, keyRotationPending: false };

async function call(route: (typeof routes)[number], input: Record<string, unknown>, slug: string | null = 'tester') {
  const ctx = { input, principal: slug ? { slug } : null } as never;
  const res = (await route.handler(new Request('http://127.0.0.1/api/governance-policy/siem-export'), ctx)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.mocked(siemExportStatus).mockReset();
  vi.mocked(siemExportNext).mockReset();
  vi.mocked(siemExportAck).mockReset();
});

describe('/api/governance-policy/siem-export/* — the SIEM delivery doors (D-018, D-019)', () => {
  it('declares three loopback POST doors at the documented paths', () => {
    expect(routes.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['POST', '/governance-policy/siem-export/status', 'loopback'],
      ['POST', '/governance-policy/siem-export/next', 'loopback'],
      ['POST', '/governance-policy/siem-export/ack', 'loopback'],
    ]);
  });

  it('stamps the human admin principal from the door, and defaults a workspace stream to the request workspace', async () => {
    mockResolvedTyped(vi.mocked(siemExportNext), NEXT);
    const out = await call(nextRoute, { stream: { kind: 'tool-invocations' }, limit: 50 });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, op: 'next', jsonl: '' });
    expect(siemExportNext).toHaveBeenCalledWith({
      principal: 'admin:tester',
      stream: { kind: 'tool-invocations', workspaceId: 'ws-active' },
      limit: 50,
      acknowledgeKeyRotation: undefined,
    });
  });

  it('passes an org-audit stream through and forwards the ack fields unchanged', async () => {
    mockResolvedTyped(vi.mocked(siemExportAck), ACK);
    const out = await call(ackRoute, {
      stream: { kind: 'org-audit', organizationId: 'org-1' },
      idempotencyKey: KEY,
      cursorTo: '2026-10-14T00:00:00.000001Z|u',
      acknowledgeKeyRotation: true,
    });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'ack', status: 'acknowledged' } });
    expect(siemExportAck).toHaveBeenCalledWith({
      principal: 'admin:tester',
      stream: { kind: 'org-audit', organizationId: 'org-1' },
      idempotencyKey: KEY,
      cursorTo: '2026-10-14T00:00:00.000001Z|u',
      acknowledgeKeyRotation: true,
    });
  });

  it('status forwards an explicit workspace and the deliveries count', async () => {
    mockResolvedTyped(vi.mocked(siemExportStatus), STATUS);
    const out = await call(statusRoute, { stream: { kind: 'tool-invocations', workspaceId: 'ws-b' }, deliveries: 3 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'status', configuredKeyId: null } });
    expect(siemExportStatus).toHaveBeenCalledWith({
      principal: 'admin:tester',
      stream: { kind: 'tool-invocations', workspaceId: 'ws-b' },
      deliveries: 3,
    });
  });

  it('maps every SIEM refusal code to its status, so a forwarder never reads a refusal as an empty batch', async () => {
    const codes = Object.keys(SIEM_EXPORT_STATUS).filter((c) => c !== 'forbidden') as SiemExportErrorCode[];
    for (const code of codes) {
      vi.mocked(siemExportNext).mockRejectedValueOnce(new SiemExportError(code, `refused: ${code}`));
      const out = await call(nextRoute, { stream: { kind: 'tool-invocations' } });
      expect(out.status, code).toBe(SIEM_EXPORT_STATUS[code]);
      expect(out.body, code).toMatchObject({ ok: false, op: 'next', code });
    }
  });

  it('answers 403 forbidden when the principal lacks approve authority', async () => {
    vi.mocked(siemExportStatus).mockRejectedValue(new SiemExportAccessError('admin:tester lacks approve over ws-active'));
    const out = await call(statusRoute, { stream: { kind: 'tool-invocations' } });
    expect(out).toMatchObject({ status: 403, body: { ok: false, op: 'status', code: 'forbidden' } });
  });

  it('rethrows an unexpected failure instead of dressing it as a refusal', async () => {
    vi.mocked(siemExportAck).mockRejectedValue(new Error('connection reset'));
    await expect(call(ackRoute, { stream: { kind: 'tool-invocations' }, idempotencyKey: KEY, cursorTo: '9' })).rejects.toThrow(
      'connection reset',
    );
  });
});
