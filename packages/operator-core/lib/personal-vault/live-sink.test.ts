import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const seams = vi.hoisted(() => ({ source: vi.fn(), store: vi.fn() }));
vi.mock('../external-triggers/source-store', () => ({ getExternalTriggerSource: seams.source }));
vi.mock('./store', async (original) => ({
  ...await original<typeof import('./store')>(),
  upsertPersonalDocuments: seams.store,
}));

import { createPersonalVaultExternalSinkForSource, personalDocumentFromExternalEvent } from './live-sink';

const event = {
  key: 'external-trigger:linkedin-company:post',
  sourceId: 'untrusted-event-source',
  datatypeId: 'social-post',
  externalId: 'post-1',
  payload: { platform: 'facebook', text: 'Company launch', author: 'urn:li:organization:123' },
};
const sql = {} as Sql;

beforeEach(() => {
  vi.clearAllMocks();
  seams.store.mockResolvedValue({ insertedOrUpdated: 1, ids: ['document-1'] });
});

describe('source-bound social Vault routing', () => {
  it.each(['linkedin-company', 'bluesky', 'facebook-pages'])(
    'stores %s posts in the source provider scope even when the payload names Facebook',
    async (kind) => {
      seams.source.mockResolvedValue({ id: 'trusted-source', kind, ownerUserId: 'local-owner', providerAccountId: 'connected-member' });
      const sink = await createPersonalVaultExternalSinkForSource(sql, 'workspace', 'trusted-source');
      await sink.deliver(event);
      expect(seams.store).toHaveBeenCalledWith(sql, 'workspace', 'local-owner', [expect.objectContaining({
        source: kind,
        sourceId: 'trusted-source',
        providerAccountId: 'connected-member',
        datatypeId: 'social-post',
        title: 'Social post',
        text: 'Company launch',
        dedupeKey: `${kind}:trusted-source:post:post-1`,
      })]);
    },
  );

  it('preserves the legacy Facebook category when no source provenance was supplied', () => {
    expect(personalDocumentFromExternalEvent(event)).toMatchObject({
      source: 'facebook', dedupeKey: 'facebook:untrusted-event-source:post:post-1',
    });
  });

  it('keeps non-social documents in their datatype category', async () => {
    seams.source.mockResolvedValue({ id: 'mail-source', kind: 'gmail', ownerUserId: 'local-owner', providerAccountId: 'connected-member' });
    const sink = await createPersonalVaultExternalSinkForSource(sql, 'workspace', 'mail-source');
    await sink.deliver({ ...event, datatypeId: 'email-message', payload: { subject: 'Mail subject', text: 'Mail body' } });
    expect(seams.store.mock.calls[0][3][0]).toMatchObject({ source: 'mail', title: 'Mail subject', text: 'Mail body' });
  });
});
