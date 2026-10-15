/**
 * Formats of sealed embeddings and telemetry records (WI-6554700010012443 U4). The key service is a
 * stand-in that binds organization and scope; organization-derived-sealing.integration.test.ts runs the
 * real key service.
 */
import { describe, expect, it } from 'vitest';
import {
  derivedSealing,
  openEmbedding,
  openTelemetryPayload,
  sealEmbedding,
  sealTelemetryPayload,
  type DerivedKeyService,
} from './organization-derived-sealing';
import { OrganizationKeyUnavailableError } from './organization-keys';
import type { Sql } from 'postgres';

const ORG = 'org-a';

const fakeService: DerivedKeyService = {
  async encrypt(organizationId, scope, plaintext) {
    return Buffer.concat([Buffer.from(`${organizationId}|${scope}|`), plaintext]);
  },
  async decrypt(organizationId, scope, blob) {
    const prefix = Buffer.from(`${organizationId}|${scope}|`);
    if (!blob.subarray(0, prefix.length).equals(prefix)) {
      throw new OrganizationKeyUnavailableError(organizationId, 'envelope-auth-failed', 'stand-in auth failure');
    }
    return blob.subarray(prefix.length);
  },
};

/** Re-wraps a stand-in blob's plaintext, so a test can hand the opener bytes it could not seal itself. */
const rewrap = (scope: string, plaintext: Buffer) => Buffer.concat([Buffer.from(`${ORG}|${scope}|`), plaintext]);

async function keyError(p: Promise<unknown>, code: OrganizationKeyUnavailableError['code']) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OrganizationKeyUnavailableError);
  expect((err as OrganizationKeyUnavailableError).code).toBe(code);
}

describe('sealed embeddings', () => {
  it('round-trips model and float32 values', async () => {
    const vector = new Float32Array([0.125, -1.5, 3.25, 0]);
    const blob = await sealEmbedding(fakeService, ORG, { model: 'embed-m1', vector });
    const opened = await openEmbedding(fakeService, ORG, blob, { model: 'embed-m1', dimension: 4 });
    expect(opened.model).toBe('embed-m1');
    expect([...opened.vector]).toEqual([0.125, -1.5, 3.25, 0]);
  });

  it('rounds a number[] to float32 precision', async () => {
    const blob = await sealEmbedding(fakeService, ORG, { model: 'm', vector: [0.1] });
    const opened = await openEmbedding(fakeService, ORG, blob);
    expect(opened.vector[0]).toBe(Math.fround(0.1));
  });

  it('refuses a vector of another model or dimension', async () => {
    const blob = await sealEmbedding(fakeService, ORG, { model: 'embed-m1', vector: [1, 2] });
    await keyError(openEmbedding(fakeService, ORG, blob, { model: 'embed-m2' }), 'envelope-malformed');
    await keyError(openEmbedding(fakeService, ORG, blob, { dimension: 3 }), 'envelope-malformed');
  });

  it('refuses a blob sealed for the telemetry scope', async () => {
    const blob = await sealTelemetryPayload(fakeService, ORG, { kind: 'trace', payload: { a: 1 } });
    await keyError(openEmbedding(fakeService, ORG, blob), 'envelope-auth-failed');
  });

  it('refuses a truncated, padded or mis-formatted plaintext', async () => {
    const blob = await sealEmbedding(fakeService, ORG, { model: 'm', vector: [1, 2, 3] });
    const plain = blob.subarray(`${ORG}|embedding|`.length);
    await keyError(openEmbedding(fakeService, ORG, rewrap('embedding', plain.subarray(0, plain.length - 1))), 'envelope-malformed');
    await keyError(openEmbedding(fakeService, ORG, rewrap('embedding', Buffer.concat([plain, Buffer.alloc(4)]))), 'envelope-malformed');
    const wrongFormat = Buffer.from(plain);
    wrongFormat[0] = 9;
    await keyError(openEmbedding(fakeService, ORG, rewrap('embedding', wrongFormat)), 'envelope-malformed');
    await keyError(openEmbedding(fakeService, ORG, rewrap('embedding', Buffer.alloc(0))), 'envelope-malformed');
  });

  it('refuses non-finite values, an empty vector and an empty model before sealing', async () => {
    await expect(sealEmbedding(fakeService, ORG, { model: 'm', vector: [1, Number.NaN] })).rejects.toThrow(/not finite/);
    await expect(sealEmbedding(fakeService, ORG, { model: 'm', vector: [Number.POSITIVE_INFINITY] })).rejects.toThrow(/not finite/);
    await expect(sealEmbedding(fakeService, ORG, { model: 'm', vector: [] })).rejects.toThrow(/dimension 0/);
    await expect(sealEmbedding(fakeService, ORG, { model: '', vector: [1] })).rejects.toThrow(/model/);
  });
});

describe('sealed telemetry records', () => {
  it('round-trips kind and payload, writing bigint as a string', async () => {
    const blob = await sealTelemetryPayload(fakeService, ORG, { kind: 'retrieval-trace', payload: { query: 'cobalt', n: 10n, hits: [1, 2] } });
    expect(blob.toString('utf8')).toContain(`${ORG}|telemetry|`);
    const opened = await openTelemetryPayload(fakeService, ORG, blob, 'retrieval-trace');
    expect(opened).toEqual({ kind: 'retrieval-trace', payload: { query: 'cobalt', n: '10', hits: [1, 2] } });
  });

  it('keeps a null payload and refuses an undefined one or an empty kind', async () => {
    const blob = await sealTelemetryPayload(fakeService, ORG, { kind: 'k', payload: null });
    expect((await openTelemetryPayload(fakeService, ORG, blob)).payload).toBeNull();
    await expect(sealTelemetryPayload(fakeService, ORG, { kind: 'k', payload: undefined })).rejects.toThrow(/undefined/);
    await expect(sealTelemetryPayload(fakeService, ORG, { kind: '', payload: 1 })).rejects.toThrow(/kind/);
  });

  it('refuses a record of another kind, a non-record and non-JSON', async () => {
    const blob = await sealTelemetryPayload(fakeService, ORG, { kind: 'a', payload: 1 });
    await keyError(openTelemetryPayload(fakeService, ORG, blob, 'b'), 'envelope-malformed');
    await keyError(openTelemetryPayload(fakeService, ORG, rewrap('telemetry', Buffer.from('{"v":2,"kind":"a","payload":1}'))), 'envelope-malformed');
    await keyError(openTelemetryPayload(fakeService, ORG, rewrap('telemetry', Buffer.from('{"v":1,"kind":"a"}'))), 'envelope-malformed');
    await keyError(openTelemetryPayload(fakeService, ORG, rewrap('telemetry', Buffer.from('null'))), 'envelope-malformed');
    await keyError(openTelemetryPayload(fakeService, ORG, rewrap('telemetry', Buffer.from('not json'))), 'envelope-malformed');
  });

  it('refuses a blob of another organization', async () => {
    const blob = await sealTelemetryPayload(fakeService, 'org-b', { kind: 'a', payload: 1 });
    await keyError(openTelemetryPayload(fakeService, ORG, blob), 'envelope-auth-failed');
  });
});

describe('derivedSealing', () => {
  const sql = {} as Sql;

  it('is null without key custody, so the store keeps plaintext', async () => {
    let built = 0;
    const sealing = await derivedSealing(sql, ORG, { custodyState: async () => null, keyService: () => { built += 1; return fakeService; } });
    expect(sealing).toBeNull();
    expect(built).toBe(0);
  });

  it('binds the helpers to the organization whenever custody exists', async () => {
    for (const state of ['enabled', 'revoked', 'shredded'] as const) {
      const sealing = await derivedSealing(sql, ORG, { custodyState: async () => state, keyService: () => fakeService });
      expect(sealing?.organizationId).toBe(ORG);
    }
    const sealing = (await derivedSealing(sql, ORG, { custodyState: async () => 'enabled', keyService: () => fakeService }))!;
    const vec = await sealing.sealEmbedding({ model: 'm', vector: [2] });
    expect([...(await sealing.openEmbedding(vec)).vector]).toEqual([2]);
    const tel = await sealing.sealTelemetry({ kind: 'k', payload: 'x' });
    expect((await sealing.openTelemetry(tel, 'k')).payload).toBe('x');
  });
});
