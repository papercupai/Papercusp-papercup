/**
 * P-017 (WI-10004021, D-032): the signed-webhook signature scheme and the refusals that happen before
 * any database read. The database-backed path (create, bind, arm, deliver, rotate) is covered by
 * webhook.integration.test.ts against real Postgres.
 */
import { createHmac } from 'node:crypto';
import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_TOLERANCE_SEC,
  handleWebhookDelivery,
  isWebhookPath,
  mintWebhookSigningKey,
  parseWebhookSignature,
  signWebhook,
  verifyWebhookSignature,
  webhookPath,
} from './webhook';

const KEY = 'whsec_test_key_one';
const OTHER = 'whsec_test_key_two';
const NOW = 1_790_000_000;
const BODY = '{"ref":"refs/heads/main","n":1}';

describe('signWebhook / verifyWebhookSignature', () => {
  it('signs HMAC-SHA256 over "<t>.<raw body>" as t=…,v1=<hex>', () => {
    const expected = createHmac('sha256', KEY).update(`${NOW}.${BODY}`).digest('hex');
    expect(signWebhook(KEY, NOW, BODY)).toBe(`t=${NOW},v1=${expected}`);
    expect(signWebhook(KEY, NOW, Buffer.from(BODY))).toBe(`t=${NOW},v1=${expected}`);
  });

  it('accepts a correct signature inside the tolerance window', () => {
    const header = signWebhook(KEY, NOW, BODY);
    expect(verifyWebhookSignature({ header, rawBody: BODY, signingKeys: [KEY], nowSec: NOW })).toEqual({ ok: true, timestampSec: NOW });
    expect(verifyWebhookSignature({ header, rawBody: BODY, signingKeys: [KEY], nowSec: NOW + WEBHOOK_TOLERANCE_SEC }).ok).toBe(true);
    expect(verifyWebhookSignature({ header, rawBody: BODY, signingKeys: [KEY], nowSec: NOW - WEBHOOK_TOLERANCE_SEC }).ok).toBe(true);
  });

  it('refuses a missing, malformed, stale, wrong-key or tampered-body signature, each with its reason', () => {
    const header = signWebhook(KEY, NOW, BODY);
    const verify = (h: string | null, body = BODY, keys = [KEY], nowSec = NOW) =>
      verifyWebhookSignature({ header: h, rawBody: body, signingKeys: keys, nowSec });
    expect(verify(null)).toEqual({ ok: false, reason: 'signature_missing' });
    expect(verify('   ')).toEqual({ ok: false, reason: 'signature_missing' });
    expect(verify('v1=abc')).toEqual({ ok: false, reason: 'signature_malformed' });
    expect(verify(`t=${NOW}`)).toEqual({ ok: false, reason: 'signature_malformed' });
    expect(verify(`t=${NOW},v1=${'z'.repeat(64)}`)).toEqual({ ok: false, reason: 'signature_malformed' });
    expect(verify(header, BODY, [KEY], NOW + WEBHOOK_TOLERANCE_SEC + 1)).toEqual({ ok: false, reason: 'signature_stale' });
    expect(verify(header, BODY, [KEY], NOW - WEBHOOK_TOLERANCE_SEC - 1)).toEqual({ ok: false, reason: 'signature_stale' });
    expect(verify(header, BODY, [OTHER])).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(verify(header, BODY.replace('"n":1', '"n":2'))).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(verify(header, BODY, [])).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('a timestamp change invalidates the signature (the timestamp is signed)', () => {
    const v1 = signWebhook(KEY, NOW, BODY).split(',')[1];
    expect(verifyWebhookSignature({ header: `t=${NOW + 1},${v1}`, rawBody: BODY, signingKeys: [KEY], nowSec: NOW }))
      .toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('accepts any currently valid key (rotation overlap) and any listed v1 value', () => {
    const header = signWebhook(OTHER, NOW, BODY);
    expect(verifyWebhookSignature({ header, rawBody: BODY, signingKeys: [KEY, OTHER], nowSec: NOW }).ok).toBe(true);
    const bogus = `v1=${'0'.repeat(64)}`;
    expect(verifyWebhookSignature({ header: `${header},${bogus}`, rawBody: BODY, signingKeys: [KEY, OTHER], nowSec: NOW }).ok).toBe(true);
  });

  it('parses t and every v1, ignores unknown schemes, and rejects a duplicate t', () => {
    expect(parseWebhookSignature(`t=5,v1=${'a'.repeat(64)},v0=zz,v1=${'b'.repeat(64)}`)).toEqual({
      timestampSec: 5,
      signatures: ['a'.repeat(64), 'b'.repeat(64)],
    });
    expect(parseWebhookSignature(`t=5,t=6,v1=${'a'.repeat(64)}`)).toBeNull();
    expect(parseWebhookSignature('x'.repeat(3000))).toBeNull();
  });

  it('mints distinct keys with 32 random bytes', () => {
    const a = mintWebhookSigningKey();
    const b = mintWebhookSigningKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });
});

describe('webhook path', () => {
  it('is exactly /api/hooks/<lowercase uuid>', () => {
    const id = '0b9f3c2e-4d51-4a7e-9c0f-2f8d6a1b3e57';
    expect(webhookPath(id)).toBe(`/api/hooks/${id}`);
    expect(isWebhookPath(webhookPath(id))).toBe(true);
    for (const path of ['/api/hooks/', `/api/hooks/${id}/x`, `/api/hooks/${id.toUpperCase()}`, `/x/api/hooks/${id}`]) {
      expect(isWebhookPath(path), path).toBe(false);
    }
  });
});

describe('handleWebhookDelivery refusals before any database read', () => {
  // Any query would throw: these refusals must write and read nothing.
  const sql = new Proxy(() => {}, {
    apply() {
      throw new Error('database touched');
    },
    get() {
      throw new Error('database touched');
    },
  }) as unknown as postgres.Sql;
  const deps = { sql, remoteAccessEnabled: async () => true, encryptionKey: 'k' };
  const request = (body: string | Uint8Array, sourceId = '0b9f3c2e-4d51-4a7e-9c0f-2f8d6a1b3e57') => ({
    sourceId,
    headers: new Headers({ 'papercusp-signature': signWebhook(KEY, NOW, body) }),
    rawBody: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  });

  it('413 for a body over the limit', async () => {
    const res = await handleWebhookDelivery(request(new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1)), deps);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('body_too_large');
  });

  it('400 for a non-empty body that is not a JSON object', async () => {
    // An EMPTY body is a provider's subscription handshake (linear-asana-task-sync D-016, Asana
    // X-Hook-Secret), so it is decided after the source lookup: a webhook source still refuses it
    // invalid_body (providers/connector-push.integration.test.ts, "the generic webhook path").
    for (const body of ['not json', '[1,2]', '"text"', 'null']) {
      const res = await handleWebhookDelivery(request(body), deps);
      expect(res.status, body).toBe(400);
      expect(res.body.error, body).toBe('invalid_body');
    }
  });

  it('404 for a source id that is not a uuid, with or without a body', async () => {
    for (const body of [BODY, '']) {
      const res = await handleWebhookDelivery(request(body, 'not-a-uuid'), deps);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'not_found' });
    }
  });
});
