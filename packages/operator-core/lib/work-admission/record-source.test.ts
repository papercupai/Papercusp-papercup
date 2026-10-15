/**
 * Unit: record write-back dispatch by capability (linear-asana-task-sync-2026-10-05 P-002, D-007).
 *
 * The record resolver's `writeBack` (ticket.comment) and `transition` (ticket.transition) pick the
 * provider registered for the record's DATA SOURCE KIND (never a provider name carried in the
 * record), refuse a provider without the capability before any host.fetch is built, and send only
 * the coordinates and the one field the capability needs. The real Postgres round trip, the
 * by-work-item-id verbs and the ledger are covered by
 * data-sources/ticket-admission.integration.test.ts.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type postgres from 'postgres';
import type { HostFetch, ProviderAdapter, ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { ProviderCapabilityUnsupported } from '../capability-verbs/provider-dispatch';
import type { AdmissionRow } from './admission-sources';
import {
  createRecordAdmissionSource,
  recordTransitionCapability,
  recordWriteBackCapability,
  type RecordSourceDeps,
} from './record-source';

type HostFetchFor = NonNullable<RecordSourceDeps['hostFetchFor']>;

const WS = 'ws-record-source-unit';
const TRACKER_SOURCE = '00000000-0000-4000-8000-000000000001';
const READ_ONLY_SOURCE = '00000000-0000-4000-8000-000000000002';

/** The data source's config; the provider receives it as `syncPage` does (P-005: Asana's section mapping). */
const SOURCE_CONFIG = { harnessSlug: 'papercusp', sectionCategories: { Doing: 'in-progress' } };

/** A tagged-template stand-in for postgres.Sql that only answers the data-source lookup. */
function fakeSql(
  kinds: Record<string, string>,
  config: Record<string, unknown> = SOURCE_CONFIG,
): { sql: postgres.Sql; queries: string[] } {
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    queries.push(text);
    if (text.includes('FROM harness_shared.data_sources')) {
      const kind = kinds[String(values[1])];
      return Promise.resolve(kind ? [{ kind, config }] : []);
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  }) as unknown as postgres.Sql;
  return { sql, queries };
}

function provider(id: string, capabilities: string[], invoke: ProviderAdapter['invoke']) {
  const descriptor: ProviderDescriptor = {
    id,
    contractVersion: 1,
    datatypes: ['ticket'],
    capabilities,
    egressHosts: [`${id}.example.com`],
  };
  const adapter: ProviderAdapter = {
    describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke,
  };
  return { descriptor, adapter, pluginName: id, runtime: 'js' } as never;
}

interface Harness {
  registry: ProviderRegistry;
  trackerCalls: ProviderInvokeRequest[];
  decoyInvoke: ReturnType<typeof vi.fn>;
  readOnlyInvoke: ReturnType<typeof vi.fn>;
  hostFetchFor: Mock<HostFetchFor>;
  bound: unknown[];
  setTrackerChanged(v: boolean): void;
}

function harness(): Harness {
  const registry = createProviderRegistry();
  const trackerCalls: ProviderInvokeRequest[] = [];
  let changed = true;
  registry.register(provider('tracker', ['ticket.read', 'ticket.comment', 'ticket.transition'], async (request, host) => {
    await host.fetch({ source: request.source, request: { url: 'https://tracker.example.com/x', method: 'POST' } });
    trackerCalls.push(request);
    return request.capability === 'ticket.comment'
      ? { externalRef: 'https://tracker.example.com/c/1', updateId: 'comment:1' }
      : changed ? { changed: true, updateId: 'history:9' } : { changed: false };
  }));
  // Named after the provider the record CLAIMS; dispatch must never reach it.
  const decoyInvoke = vi.fn(async () => ({ updateId: 'decoy' }));
  registry.register(provider('decoy', ['ticket.read', 'ticket.comment', 'ticket.transition'], decoyInvoke));
  const readOnlyInvoke = vi.fn(async () => ({}));
  registry.register(provider('read-only', ['ticket.read'], readOnlyInvoke));
  const bound: unknown[] = [];
  const hostFetchFor = vi.fn<HostFetchFor>((_db, input): HostFetch => {
    bound.push(input);
    return async ({ source }) => {
      expect(source).toBe(input.sourceId);
      return { status: 200, headers: {}, body: '{}', bodyEncoding: 'utf8' };
    };
  });
  return { registry, trackerCalls, decoyInvoke, readOnlyInvoke, hostFetchFor, bound, setTrackerChanged: (v) => { changed = v; } };
}

function admission(dataSourceId: string | null): AdmissionRow {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    workspaceId: WS,
    workItemId: 'WI-unit-1',
    dataSourceId,
    sourceKind: 'record',
    sourceKey: 'DSR-unit-1',
    // Source-owned fields ride along on the record; none of them may be sent.
    sourceRef: {
      recordId: 'DSR-unit-1', datatype: 'ticket', externalId: 'T-1', provider: 'decoy',
      title: 'Source title', body: 'Source description', assignees: ['someone'], url: 'https://tracker.example.com/T-1',
    },
    admittedVia: 'person',
    admittedBy: 'su-unit',
    ruleId: null,
    createdAt: '2026-10-06T00:00:00.000Z',
  };
}

const KINDS = { [TRACKER_SOURCE]: 'tracker', [READ_ONLY_SOURCE]: 'read-only' };

describe('record write-back capability names', () => {
  it('derive <datatype>.comment and <datatype>.transition from the record datatype', () => {
    expect(recordWriteBackCapability('ticket')).toBe('ticket.comment');
    expect(recordTransitionCapability('ticket')).toBe('ticket.transition');
    expect(recordTransitionCapability('work-task')).toBe('worktask.transition');
  });
});

describe('write-back reads the token from the install that connected the source, never the admission target (WI-10006662)', () => {
  // The OAuth callback stores the token under the install that ran the flow ('papercusp' unless the
  // source records another as installSlug). `harnessSlug` is where ADMITTED WORK lands; its token
  // store is empty, so binding host.fetch to it failed every write-back as reconnect-required.
  it.each([
    ['work admitted into another harness', { harnessSlug: 'project-x' }, 'papercusp'],
    ['a source with no target harness yet', {}, 'papercusp'],
    ['a source that records its install', { harnessSlug: 'project-x', installSlug: 'other-install' }, 'other-install'],
  ])('%s: host.fetch is bound to the token-store install', async (_label, config, tokenHarness) => {
    const h = harness();
    const { sql } = fakeSql(KINDS, config);
    const source = createRecordAdmissionSource({ registry: h.registry, hostFetchFor: h.hostFetchFor });

    await source.writeBack!({ db: sql, admission: admission(TRACKER_SOURCE), text: 'triaged' });
    await source.transition!({ db: sql, admission: admission(TRACKER_SOURCE), toCategory: 'done' });

    expect(h.bound).toEqual([
      { workspaceId: WS, providerId: 'tracker', sourceId: TRACKER_SOURCE, harness: tokenHarness },
      { workspaceId: WS, providerId: 'tracker', sourceId: TRACKER_SOURCE, harness: tokenHarness },
    ]);
  });
});

describe('record write-back dispatches by the data source, through the capability (P-002)', () => {
  it('posts a comment through the provider of the record’s source kind, never the provider the record names', async () => {
    const h = harness();
    const { sql } = fakeSql(KINDS);
    const source = createRecordAdmissionSource({ registry: h.registry, hostFetchFor: h.hostFetchFor });

    const res = await source.writeBack!({ db: sql, admission: admission(TRACKER_SOURCE), text: 'triaged' });

    expect(res).toEqual({ posted: true, externalRef: 'https://tracker.example.com/c/1', updateId: 'comment:1' });
    expect(h.trackerCalls).toEqual([
      { source: TRACKER_SOURCE, capability: 'ticket.comment', args: { externalId: 'T-1', text: 'triaged' }, config: SOURCE_CONFIG },
    ]);
    expect(h.bound).toEqual([{ workspaceId: WS, providerId: 'tracker', sourceId: TRACKER_SOURCE, harness: 'papercusp' }]);
    expect(h.decoyInvoke).not.toHaveBeenCalled();
  });

  it('moves the source to a category sending only the category, and reports an unchanged move', async () => {
    const h = harness();
    const { sql } = fakeSql(KINDS);
    const source = createRecordAdmissionSource({ registry: h.registry, hostFetchFor: h.hostFetchFor });

    const moved = await source.transition!({ db: sql, admission: admission(TRACKER_SOURCE), toCategory: 'done' });
    expect(moved).toEqual({ transitioned: true, updateId: 'history:9', externalRef: null });
    // Field authority: title, description and assignee belong to the source and never travel.
    expect(h.trackerCalls).toEqual([
      { source: TRACKER_SOURCE, capability: 'ticket.transition', args: { externalId: 'T-1', toCategory: 'done' }, config: SOURCE_CONFIG },
    ]);

    h.setTrackerChanged(false);
    expect(await source.transition!({ db: sql, admission: admission(TRACKER_SOURCE), toCategory: 'done' }))
      .toEqual({ transitioned: false, updateId: null, externalRef: null });
    expect(h.decoyInvoke).not.toHaveBeenCalled();
  });

  it('refuses a provider without the capability, by name, before building a host.fetch or invoking it', async () => {
    const h = harness();
    const { sql } = fakeSql(KINDS);
    const source = createRecordAdmissionSource({ registry: h.registry, hostFetchFor: h.hostFetchFor });

    const comment = source.writeBack!({ db: sql, admission: admission(READ_ONLY_SOURCE), text: 'triaged' });
    await expect(comment).rejects.toBeInstanceOf(ProviderCapabilityUnsupported);
    await expect(comment).rejects.toThrow('provider_capability_unsupported:read-only:ticket.comment');
    await expect(source.transition!({ db: sql, admission: admission(READ_ONLY_SOURCE), toCategory: 'in-progress' }))
      .rejects.toThrow('provider_capability_unsupported:read-only:ticket.transition');

    expect(h.hostFetchFor).not.toHaveBeenCalled();
    expect(h.readOnlyInvoke).not.toHaveBeenCalled();
    expect(h.decoyInvoke).not.toHaveBeenCalled();
  });

  it('refuses an unknown category before reading the source or calling any provider', async () => {
    const h = harness();
    const { sql, queries } = fakeSql(KINDS);
    const source = createRecordAdmissionSource({ registry: h.registry, hostFetchFor: h.hostFetchFor });

    await expect(source.transition!({ db: sql, admission: admission(TRACKER_SOURCE), toCategory: 'shipped' }))
      .rejects.toThrow(/^transition_category_invalid:shipped/);
    expect(queries).toEqual([]);
    expect(h.trackerCalls).toEqual([]);
    expect(h.hostFetchFor).not.toHaveBeenCalled();
  });

  it('refuses a record admission without durable coordinates', async () => {
    const h = harness();
    const { sql } = fakeSql(KINDS);
    const source = createRecordAdmissionSource({ registry: h.registry, hostFetchFor: h.hostFetchFor });

    await expect(source.writeBack!({ db: sql, admission: admission(null), text: 'triaged' }))
      .rejects.toThrow('write_back_coordinates_missing');
    expect(h.trackerCalls).toEqual([]);
  });
});
