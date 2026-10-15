/**
 * Gmail `sync.adopt` (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-008 / D-020).
 *
 * A gmail data source the retired host Gmail poll drove carries that poll's cursor
 * (`historyId`, `emailAddress`, `watchExpiration`, resumable `backfill`). The connector driver asks
 * the provider to adopt it before the first page, so the first connector pass continues from where
 * the poll stopped. A null start would re-walk the mailbox under new delivery keys and deliver
 * every already-ingested message a second time. These tests drive the REAL bundled package
 * (`libs/papercusp/plugins/gmail`) through its public `providerAdapter`, with `host.fetch` stubbed.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, ProviderAdapter, ProviderAdoptResult } from '@papercusp/plugin-sdk';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const gmail = require(join(REPO_ROOT, 'libs/papercusp/plugins/gmail/index.cjs')) as {
  providerAdapter: ProviderAdapter;
  _internal: { decodeCursor: (raw: string | null) => Record<string, unknown> | null };
};
const adapter = gmail.providerAdapter;
const SOURCE = '00000000-0000-4000-8000-0000000000aa';

const noFetch = (async () => {
  throw new Error('sync.adopt must not touch the network');
}) as unknown as HostFetch;

async function adopt(prior: Record<string, unknown>): Promise<ProviderAdoptResult> {
  return (await adapter.invoke(
    { source: SOURCE, capability: 'sync.adopt', args: { prior } },
    { fetch: noFetch },
  )) as ProviderAdoptResult;
}

async function adoptedCursor(prior: Record<string, unknown>) {
  const result = await adopt(prior);
  expect(typeof result.cursor).toBe('string');
  return { result, cursor: gmail._internal.decodeCursor(result.cursor) };
}

describe('gmail sync.adopt maps the retired poll cursor (D-020)', () => {
  it('declares sync.adopt on its descriptor', async () => {
    const descriptor = await adapter.describe();
    expect(descriptor.capabilities).toContain('sync.adopt');
  });

  it('a mailbox cursored before resumable backfill existed adopts as backfill-complete', async () => {
    // Shape of live source c8fab094 on 2026-10-06: no `backfill` key.
    const { result, cursor } = await adoptedCursor({
      historyId: '131539',
      emailAddress: 'super@papercusp.com',
      watchExpiration: '2026-10-12T00:00:00.000Z',
      lastSyncAt: '2026-10-06T03:50:45.000Z',
    });
    expect(result.backfillComplete).toBe(true);
    expect(cursor).toEqual({
      v: 1,
      emailAddress: 'super@papercusp.com',
      historyId: '131539',
      history: { pageToken: null },
      backfill: { status: 'complete', pageToken: null, messages: 0 },
      watch: { expiration: '2026-10-12T00:00:00.000Z', topicName: null, topicReady: null },
    });
  });

  it('an in-flight legacy backfill resumes at its messages.list page token', async () => {
    // Shape of live source 15508859 on 2026-10-06: backfill pending after 92,449 messages.
    const { result, cursor } = await adoptedCursor({
      historyId: '71911624',
      emailAddress: 'owner@example.com',
      backfill: { status: 'pending', pageToken: '09703728201826188811', messages: 92449, pages: 925 },
    });
    expect(result.backfillComplete).toBe(false);
    expect(cursor).toMatchObject({
      historyId: '71911624',
      backfill: { status: 'pending', pageToken: '09703728201826188811', messages: 92449 },
    });
  });

  it('a throttled legacy backfill resumes as pending, and a completed one stays complete', async () => {
    const throttled = await adoptedCursor({ historyId: '10', backfill: { status: 'throttled', pageToken: 'tok', messages: 5 } });
    expect(throttled.result.backfillComplete).toBe(false);
    expect(throttled.cursor).toMatchObject({ backfill: { status: 'pending', pageToken: 'tok', messages: 5 } });

    const done = await adoptedCursor({ historyId: '11', backfill: { status: 'complete', pageToken: null, messages: 40 } });
    expect(done.result.backfillComplete).toBe(true);
    expect(done.cursor).toMatchObject({ backfill: { status: 'complete', pageToken: null, messages: 40 } });
  });

  it('accepts a numeric or snake_case history id', async () => {
    expect((await adoptedCursor({ historyId: 4242 })).cursor).toMatchObject({ historyId: '4242' });
    expect((await adoptedCursor({ history_id: '77', email_address: 'x@example.com' })).cursor).toMatchObject({
      historyId: '77',
      emailAddress: 'x@example.com',
    });
  });

  it('no history position means nothing to adopt', async () => {
    // Shape of the disabled source 62b7f9e2: never got a history id.
    expect(await adopt({ lastSyncAt: '2026-09-06T15:10:26Z', emailAddress: 'a@example.com' })).toEqual({
      cursor: null,
      backfillComplete: false,
    });
    expect(await adopt({ historyId: '   ' })).toEqual({ cursor: null, backfillComplete: false });
    expect(await adopt({ historyId: -3 })).toEqual({ cursor: null, backfillComplete: false });
  });

  it('the first page after adoption replays history from the legacy position and does not backfill', async () => {
    const { result } = await adoptedCursor({ historyId: '131539', emailAddress: 'super@papercusp.com' });
    const urls: string[] = [];
    const fetch = (async ({ request: req }: { source: string; request: HostFetchRequest }) => {
      urls.push(req.url);
      if (req.url.includes('/history?')) {
        return { status: 200, headers: {}, body: JSON.stringify({ historyId: '131600' }), bodyEncoding: 'utf8' };
      }
      throw new Error(`unexpected fetch ${req.url}`);
    }) as unknown as HostFetch;

    const page = await adapter.syncPage({ source: SOURCE, cursor: result.cursor, mode: 'incremental' }, { fetch });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('startHistoryId=131539');
    expect(urls.some((url) => url.includes('/messages?'))).toBe(false);
    expect(page).toMatchObject({ records: [], hasMore: false });
    expect(gmail._internal.decodeCursor(page.nextCursor)).toMatchObject({
      historyId: '131600',
      backfill: { status: 'complete' },
    });
  });
});
