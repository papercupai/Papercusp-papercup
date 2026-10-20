/**
 * Google Contacts provider contract evidence (plan provider-adapters-to-packages-2026-10-11, P-004 / D-036).
 *
 * The app-code contacts poll (personal-vault/live-sink.ts syncGoogleContacts) and the contacts-access
 * check in external-triggers/google-workspace.ts moved into the bundled `google-contacts` package. These
 * drive the REAL package (`libs/papercusp/plugins/google-contacts`) through its public `providerAdapter`
 * with `host.fetch` stubbed: the canonical `contact` mapping (which must satisfy the workspace
 * `contact` datatype's required `id`), the one-page cursor, the sync error classes the host
 * interprets, and the `contacts.read` access check.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse, ProviderAdapter, ProviderSyncPage } from '@papercusp/plugin-sdk';
import { validateDatatypePayload } from '../../datatype-payload-validation';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const require = createRequire(import.meta.url);
const contacts = require(join(REPO_ROOT, 'libs/papercusp/plugins/google-contacts/index.cjs')) as {
  providerAdapter: ProviderAdapter;
  _internal: {
    normalizeContact: (person: unknown) => Record<string, unknown> | null;
    decodeCursor: (raw: string | null | undefined) => { v: 1; pageToken: string | null };
  };
};
const adapter = contacts.providerAdapter;
const SOURCE = '00000000-0000-4000-8000-0000000000dd';
const CONNECTIONS = 'https://people.googleapis.com/v1/people/me/connections';

/** The workspace `contact` datatype schema (seeded; the ingestion path validates against it). */
const CONTACT_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
    emails: { type: 'array', items: { type: 'string' } },
    phones: { type: 'array', items: { type: 'string' } },
    source: { type: 'string' },
    displayName: { type: 'string' },
    organizations: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
};

type Answer = { status?: number; json?: unknown; headers?: Record<string, string>; raw?: string };

function host(answer: (url: URL) => Answer) {
  const calls: HostFetchRequest[] = [];
  const fetch: HostFetch = async ({ source, request }) => {
    expect(source).toBe(SOURCE);
    calls.push(request);
    const reply = answer(new URL(request.url));
    const response: HostFetchResponse = {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
      body: reply.raw ?? (reply.json === undefined ? '' : JSON.stringify(reply.json)),
      bodyEncoding: 'utf8',
    };
    return response;
  };
  return { calls, host: { fetch } };
}

async function syncPage(cursor: string | null, answer: (url: URL) => Answer) {
  const h = host(answer);
  const page = await adapter.syncPage!(
    { source: SOURCE, cursor, mode: cursor === null ? 'backfill' : 'incremental' },
    h.host,
  ) as ProviderSyncPage;
  return { page, calls: h.calls };
}

async function syncError(answer: Answer): Promise<Record<string, unknown>> {
  try {
    await syncPage(null, () => answer);
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error('expected syncPage to throw');
}

const ADA = {
  resourceName: 'people/c1',
  etag: '%EgUBAgMFBy4aBAECBQciDEZ0',
  names: [{ displayName: 'Ada Lovelace' }],
  emailAddresses: [{ value: 'ada@example.com' }, { value: ' ' }, { value: 'ada@work.example' }],
  phoneNumbers: [{ value: '+1 555 0100' }],
  organizations: [{ name: 'Analytical Engines' }],
};

describe('google-contacts provider package', () => {
  it('describes the contacts provider in the shared google credential group', () => {
    const descriptor = adapter.describe() as unknown as Record<string, unknown>;
    expect(descriptor).toMatchObject({ id: 'contacts', capabilities: ['contacts.read'], datatypes: ['contact'] });
  });

  it('maps a People API person to a canonical contact the workspace datatype accepts', () => {
    const payload = contacts._internal.normalizeContact(ADA);
    expect(payload).toEqual({
      id: 'people/c1',
      source: 'google-contacts',
      resourceName: 'people/c1',
      displayName: 'Ada Lovelace',
      emails: ['ada@example.com', 'ada@work.example'],
      phones: ['+1 555 0100'],
      organizations: ['Analytical Engines'],
      extensions: { google: { etag: '%EgUBAgMFBy4aBAECBQciDEZ0' } },
    });
    expect(validateDatatypePayload(CONTACT_SCHEMA, payload)).toMatchObject({ ok: true });
  });

  it('omits a missing display name instead of sending null, which the contact schema rejects', () => {
    const payload = contacts._internal.normalizeContact({ resourceName: 'people/c2', emailAddresses: [{ value: 'x@example.com' }] });
    expect(payload).not.toHaveProperty('displayName');
    expect(validateDatatypePayload(CONTACT_SCHEMA, payload)).toMatchObject({ ok: true });
  });

  it('drops a person with no resourceName, the only stable id', () => {
    expect(contacts._internal.normalizeContact({ names: [{ displayName: 'No id' }] })).toBeNull();
    expect(contacts._internal.normalizeContact(null)).toBeNull();
  });

  it('reads one connections page and emits contact-changed records keyed and versioned by Google', async () => {
    const { page, calls } = await syncPage(null, () => ({
      json: {
        connections: [ADA, { names: [{ displayName: 'skipped, no id' }] }, { resourceName: 'people/c3', metadata: { deleted: true } }],
        nextPageToken: 'page-2',
      },
    }));
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(CONNECTIONS);
    expect(url.searchParams.get('personFields')).toBe('names,emailAddresses,phoneNumbers,organizations,metadata');
    expect(url.searchParams.get('pageSize')).toBe('1000');
    expect(url.searchParams.has('pageToken')).toBe(false);
    expect(page.records).toHaveLength(2);
    expect(page.records[0]).toMatchObject({
      datatype: 'contact', event: 'contact-changed', nativeId: 'people/c1', version: ADA.etag,
    });
    expect(page.records[1]).toMatchObject({ nativeId: 'people/c3', deleted: true });
    expect(page.records[1]).not.toHaveProperty('version');
    expect(page).toMatchObject({ hasMore: true, nextCursor: JSON.stringify({ v: 1, pageToken: 'page-2' }) });
  });

  it('resumes from the cursor page token and ends the pass with a null cursor', async () => {
    const { page, calls } = await syncPage(JSON.stringify({ v: 1, pageToken: 'page-2' }), () => ({ json: { connections: [] } }));
    expect(new URL(calls[0].url).searchParams.get('pageToken')).toBe('page-2');
    expect(page).toMatchObject({ records: [], nextCursor: null, hasMore: false });
  });

  it('treats an unreadable or foreign cursor as cursor-expired', () => {
    expect(() => contacts._internal.decodeCursor('not json')).toThrow(expect.objectContaining({ kind: 'cursor-expired' }));
    expect(() => contacts._internal.decodeCursor(JSON.stringify({ v: 2 }))).toThrow(expect.objectContaining({ kind: 'cursor-expired' }));
    expect(contacts._internal.decodeCursor(null)).toEqual({ v: 1, pageToken: null });
  });

  it('classifies People API failures into the sync error kinds the host interprets', async () => {
    expect(await syncError({ status: 429, headers: { 'Retry-After': '17' }, json: { error: { message: 'slow down' } } }))
      .toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 17, status: 429 });
    expect(await syncError({ status: 403, json: { error: { message: 'Quota exceeded for quota metric' } } }))
      .toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 60 });
    expect(await syncError({ status: 403, json: { error: { message: 'insufficient scopes' } } })).toMatchObject({ kind: 'auth' });
    expect(await syncError({ status: 401 })).toMatchObject({ kind: 'auth' });
    expect(await syncError({ status: 400, json: { error: { message: 'Invalid page token' } } })).toMatchObject({ kind: 'cursor-expired' });
    expect(await syncError({ status: 410 })).toMatchObject({ kind: 'cursor-expired' });
    expect(await syncError({ status: 503 })).toMatchObject({ kind: 'transient' });
    expect(await syncError({ status: 200, raw: '<html>' })).toMatchObject({ kind: 'transient' });
  });

  it('contacts.read proves the grant with a one-contact connections read', async () => {
    const h = host(() => ({ json: { connections: [ADA], nextPageToken: 'more' } }));
    const result = await adapter.invoke!({ capability: 'contacts.read', source: SOURCE, args: {} } as never, h.host as never);
    expect(new URL(h.calls[0].url).searchParams.get('pageSize')).toBe('1');
    expect(result).toEqual({ contacts: [contacts._internal.normalizeContact(ADA)], nextPageToken: 'more' });
  });

  it('refuses a capability the descriptor does not declare', async () => {
    const h = host(() => ({ json: {} }));
    await expect(adapter.invoke!({ capability: 'contacts.write', source: SOURCE, args: {} } as never, h.host as never))
      .rejects.toThrow('provider_capability_unsupported:contacts.write');
    expect(h.calls).toHaveLength(0);
  });
});
