import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ get: vi.fn(), claim: vi.fn(), sql: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../event-key-registry-store', () => ({ getEventKey: h.get, claimEventKey: h.claim }));
import { readSavedEventCatalog, saveEventType, validateSavedEventPayload } from './saved-event-type';

const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
const prior = { eventKey: 'demo:ready', title: 'Ready', description: 'A result is ready', contributor: 'local:alice',
  status: 'active', tags: ['demo'], payloadSchema: schema, keyPattern: null };
const sql = h.sql as unknown as postgres.Sql;

beforeEach(() => {
  vi.resetAllMocks();
  h.get.mockResolvedValue(null);
  h.claim.mockResolvedValue({ claimed: true, row: prior });
  h.sql.mockResolvedValue([]);
});

describe('saved event type lifecycle', () => {
  it('uses the existing atomic contributor claim and preserves a schema on an idempotent save', async () => {
    h.get.mockResolvedValue(prior);
    await saveEventType({ workspaceId: 'ws', ownerId: 'alice', event: 'demo:ready' }, sql);
    expect(h.claim).toHaveBeenCalledWith(sql, expect.objectContaining({ contributor: 'local:alice', payloadSchema: schema,
      tags: ['demo'], title: 'Ready', status: 'active' }));
  });

  it('refuses foreign ownership and a concurrent claimant without overwriting their type', async () => {
    h.get.mockResolvedValue({ ...prior, contributor: 'plugin:other' });
    await expect(saveEventType({ workspaceId: 'ws', ownerId: 'alice', event: 'demo:ready' }, sql)).rejects.toThrow('event_type_owned');
    expect(h.claim).not.toHaveBeenCalled();
    h.get.mockResolvedValue(null);
    h.claim.mockResolvedValue({ claimed: false, holder: 'local:bob' });
    await expect(saveEventType({ workspaceId: 'ws', ownerId: 'alice', event: 'demo:ready' }, sql)).rejects.toThrow('local:bob');
  });

  it('rejects malformed and asynchronous schemas before storing a declaration', async () => {
    for (const payloadSchema of [{ type: 'not-a-type' }, { $async: true, type: 'object' }]) {
      await expect(saveEventType({ workspaceId: 'ws', ownerId: 'alice', event: 'demo:ready', payloadSchema }, sql)).rejects.toThrow();
    }
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('retires an owned type without discarding its payload contract', async () => {
    h.get.mockResolvedValue(prior);
    await saveEventType({ workspaceId: 'ws', ownerId: 'alice', event: 'demo:ready', eventStatus: 'retired' }, sql);
    expect(h.claim).toHaveBeenCalledWith(sql, expect.objectContaining({ status: 'retired', payloadSchema: schema }));
  });
});

describe('saved event payloads and discovery', () => {
  it('checks exact and matching family schemas while ignoring unrelated families', async () => {
    h.sql.mockResolvedValue([{ event_key: 'demo:ready:*', key_pattern: 'demo:ready:<env>', payload_schema: schema }]);
    await expect(validateSavedEventPayload('ws', 'demo:ready:staging', { count: 3 }, sql)).resolves.toBeUndefined();
    await expect(validateSavedEventPayload('ws', 'demo:ready:staging', { count: '3' }, sql)).rejects.toThrow('event_payload_invalid');
    await expect(validateSavedEventPayload('ws', 'other:ready', {}, sql)).resolves.toBeUndefined();
    h.sql.mockResolvedValue([{ event_key: 'demo:ready', key_pattern: null, payload_schema: schema }]);
    await expect(validateSavedEventPayload('ws', 'demo:ready', {}, sql)).rejects.toThrow('count');
  });

  it('feeds durable active types to the existing catalog with local provenance', async () => {
    h.sql.mockResolvedValue([{ event_key: 'demo:ready', key_pattern: null, description: 'A result is ready', contributor: 'local:alice' }]);
    expect(await readSavedEventCatalog('private-ws', sql)).toEqual([{ unit: 'local:alice', events: [{
      family: 'local:demo:ready', keyTemplate: 'demo:ready', describe: 'A result is ready',
    }] }]);
    expect(h.sql.mock.calls[0][1]).toBe('private-ws');
  });
});
