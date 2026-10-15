import { describe, expect, it } from 'vitest';
import {
  chatMessageInputFromRecord, corpusRouteFor, legacyChatMessageDocumentKeys, renderChatUnit, rollupRetryDelaySeconds,
  splitIntoWindows,
} from './chat-retrieval-units';

// WI-6554700010012111: the delay before a failed bucket is retried.
describe('rollupRetryDelaySeconds', () => {
  it('doubles the base delay with each consecutive failure, up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => rollupRetryDelaySeconds(n, 300, 6 * 3600)))
      .toEqual([300, 600, 1200, 2400, 4800, 9600, 19200]);
    expect(rollupRetryDelaySeconds(8, 300, 6 * 3600)).toBe(6 * 3600);
    expect(rollupRetryDelaySeconds(1000, 300, 6 * 3600)).toBe(6 * 3600);
  });

  it('never waits less than the base delay, and a zero base never waits', () => {
    expect(rollupRetryDelaySeconds(3, 300, 100)).toBe(300);
    expect(rollupRetryDelaySeconds(0, 300, 6 * 3600)).toBe(300);
    expect(rollupRetryDelaySeconds(5, 0, 6 * 3600)).toBe(0);
  });
});

const at = (iso: string) => ({ postedAt: new Date(iso), id: iso });

describe('splitIntoWindows', () => {
  it('starts a new window when the gap exceeds the threshold', () => {
    const windows = splitIntoWindows([
      at('2026-09-30T10:00:00Z'), at('2026-09-30T10:30:00Z'), at('2026-09-30T11:00:01Z'),
    ], 30 * 60_000);
    expect(windows.map((w) => w.length)).toEqual([2, 1]);
  });

  it('never lets a window cross a UTC day boundary', () => {
    const windows = splitIntoWindows([at('2026-09-30T23:55:00Z'), at('2026-10-01T00:05:00Z')], 30 * 60_000);
    expect(windows.map((w) => w.length)).toEqual([1, 1]);
  });

  it('returns no windows for no messages', () => {
    expect(splitIntoWindows([], 60_000)).toEqual([]);
  });
});

describe('renderChatUnit', () => {
  it('prefers the author label, then the author ref', () => {
    expect(renderChatUnit([
      { providerMessageId: '1', authorRef: 'U1', authorLabel: 'alice', body: 'hi', postedAt: new Date() },
      { providerMessageId: '2', authorRef: 'U2', authorLabel: null, body: 'yo', postedAt: new Date() },
      { providerMessageId: '3', authorRef: null, authorLabel: null, body: '?', postedAt: new Date() },
    ])).toBe('alice: hi\nU2: yo\nunknown: ?');
  });
});

describe('corpusRouteFor', () => {
  const base = {
    kind: 'slack',
    scope: 'organization',
    datatype_mappings: { message: 'chat-message' },
    destination_policy: { 'chat-message': ['document', 'event'] },
    permission_mapping: { mode: 'source-acl' },
  };

  it('writes an organization source routed to documents with a source ACL', () => {
    expect(corpusRouteFor(base)).toEqual({ write: true, scope: 'organization', source: 'slack' });
  });

  it('refuses event-only routing and an organization source without a source ACL', () => {
    expect(corpusRouteFor({ ...base, destination_policy: { 'chat-message': ['event'] } }))
      .toEqual({ write: false, reason: 'destination_not_document' });
    expect(corpusRouteFor({ ...base, permission_mapping: { mode: 'owner' } }))
      .toEqual({ write: false, reason: 'permission_mapping_mismatch' });
  });

  it('routes a personal source to its owner vault, keyed by the provider account', () => {
    const personal = {
      ...base, scope: 'personal', permission_mapping: { mode: 'owner' },
      owner_user_id: 'u-1', provider_account_id: 'T1:UALICE',
    };
    expect(corpusRouteFor(personal))
      .toEqual({ write: true, scope: 'personal', source: 'slack', userId: 'u-1', providerAccountId: 'T1:UALICE' });
    expect(corpusRouteFor({ ...personal, permission_mapping: { mode: 'source-acl' } }))
      .toEqual({ write: false, reason: 'permission_mapping_mismatch' });
    expect(corpusRouteFor({ ...personal, owner_user_id: null })).toEqual({ write: false, reason: 'personal_owner_missing' });
    expect(corpusRouteFor({ ...personal, provider_account_id: ' ' })).toEqual({ write: false, reason: 'personal_account_missing' });
  });

  it('routes a pot source to its scope_ref, and refuses a source ACL that a pot row cannot carry', () => {
    const pot = { ...base, scope: 'pot', permission_mapping: { mode: 'owner' }, scope_ref: 'research-pot' };
    expect(corpusRouteFor(pot)).toEqual({ write: true, scope: 'pot', source: 'slack', potSlug: 'research-pot' });
    expect(corpusRouteFor({ ...pot, permission_mapping: { mode: 'source-acl' } }))
      .toEqual({ write: false, reason: 'permission_mapping_mismatch' });
    expect(corpusRouteFor({ ...pot, scope_ref: null })).toEqual({ write: false, reason: 'pot_ref_missing' });
    expect(corpusRouteFor({ ...base, scope: 'team' })).toEqual({ write: false, reason: 'scope_unknown' });
  });

  it('follows a custom datatype mapping for messages, keyed by the chat-message datatype id', () => {
    expect(corpusRouteFor({
      ...base, datatype_mappings: { 'chat-message': 'slack-message' }, destination_policy: { 'slack-message': ['document'] },
    })).toEqual({ write: true, scope: 'organization', source: 'slack' });
    // The pre-D-016 `message` key is not the datatype id the document sink routes by; it is ignored.
    expect(corpusRouteFor({
      ...base, datatype_mappings: { message: 'slack-message' }, destination_policy: { 'slack-message': ['document'] },
    })).toEqual({ write: false, reason: 'destination_not_document' });
  });
});

describe('chatMessageInputFromRecord', () => {
  it('reads a provider-neutral chat-message record into a raw chat message', () => {
    const input = chatMessageInputFromRecord({
      externalId: 'C1:1728900000.000100',
      occurredAt: '2026-10-14T03:00:00Z',
      payload: { channelId: 'C1', threadKey: '1728899000.000001', sender: 'U1', senderLabel: 'Alice', text: 'quartz' },
    });
    expect(input).toMatchObject({
      channelId: 'C1', providerMessageId: 'C1:1728900000.000100', threadKey: '1728899000.000001',
      authorRef: 'U1', authorLabel: 'Alice', body: 'quartz', postedAt: '2026-10-14T03:00:00Z',
    });
  });

  it('falls back to the ACL ref for the channel, a null thread, and the payload time', () => {
    const input = chatMessageInputFromRecord({
      externalId: 'm-2',
      payload: { aclRef: 'C9', threadKey: '  ', occurredAt: '2026-10-14T04:00:00Z', body: 'plain body' },
    });
    expect(input).toMatchObject({
      channelId: 'C9', threadKey: null, authorRef: null, authorLabel: null, body: 'plain body', postedAt: '2026-10-14T04:00:00Z',
    });
  });
});

describe('legacyChatMessageDocumentKeys', () => {
  it('names the sink key of an organization row', () => {
    expect(legacyChatMessageDocumentKeys({ sourceId: 'src-1', corpusSource: 'slack', externalId: 'm-1' }))
      .toEqual(['chat-message:src-1:m-1']);
  });

  it('adds the account-prefixed vault key of a personal row', () => {
    const keys = legacyChatMessageDocumentKeys({
      sourceId: 'src-1', corpusSource: 'slack', externalId: 'm-1', providerAccountId: 'acct-7',
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('chat-message:src-1:m-1');
    expect(keys[1]).toMatch(/^account:[0-9a-f]{64}:chat-message:src-1:m-1$/);
  });
});
