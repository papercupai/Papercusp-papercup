/**
 * Ticket admission into work against real Postgres (plan enterprise-data-sources-2026-10-01
 * P-020, D-004, D-030; ported to the shared connector driver by
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05 P-010 / D-015).
 *
 * The REAL GitHub issues provider package, the shared connector driver with its default datatype
 * sinks, admission rules, admitWorkItem, createWorkItem and linkWorkItem run; only GitHub's REST
 * responses are recorded (served through host.fetch).
 *
 * Properties under test:
 *   - an ingested ticket becomes work ONLY through an admission: a rule of its data source that
 *     matches it, or a person promoting it. An unmatched ticket stays a record;
 *   - every work item minted from a ticket carries exactly one work_admissions row naming the
 *     rule (admitted_via 'rule', rule_id) or the person (admitted_via 'person', admitted_by);
 *   - admission is idempotent: a re-sync and a second promote return the existing admission;
 *   - field authority: a Papercusp patch of an external-owned field (title, description) is
 *     refused, and a re-sync updates those fields without touching Papercusp-owned state;
 *   - a rule cannot admit outside its data source, and an event row is never admitted;
 *   - write-back dispatches by capability (D-015.5): a provider without the capability (GitHub
 *     for `ticket.transition`, a read-only fixture for both) is refused
 *     `provider_capability_unsupported`; a provider declaring `ticket.comment` is invoked through
 *     a host.fetch bound to exactly the record's source;
 *   - linear-asana-task-sync P-002: a comment or a workflow transition is requested by work-item
 *     id, a transition sends only the category (field authority), and every write is ledgered
 *     with the provider's update id so the host recognises its own change (echo suppression).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { HostFetch, HostFetchResponse, ProviderAdapter, ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { validateProviderDescriptor } from '@papercusp/plugin-sdk';
import { loadPlugins } from '@papercusp/plugin-loader';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { registerPluginProviders } from '../plugin-host-runtime';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { runConnectorSync } from '../providers/connector-runtime';
import { dataSourceRecordId } from './datatype-destination-sink';
import { setAdmissionRule } from '../work-admission/admission-rules';
import {
  admissionsForWorkItem,
  admitWorkItem,
  refuseExternalOwnedPatch,
  transitionAdmission,
  writeBackAdmission,
} from '../work-admission/admit';
import { createRecordAdmissionSource } from '../work-admission/record-source';
import { quoteEndUserTitle } from '../harness/improvements/untrusted-evidence';
import { findAdmissionWriteBack, writeBacksForWorkItem } from '../work-admission/write-back-ledger';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PACKAGE_DIR = join(REPO_ROOT, 'libs/papercusp/plugins/github-issues');
const ROOT = join(tmpdir(), `papercusp-ticket-admission-it-${process.pid}-${Date.now()}`);

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const GITHUB = 'github-issues';
const WRITABLE = 'ticket-fixture';
const OWNER = 'acme';
const REPO = 'tulip';
const CONNECTOR_ROW_RE = '^DS[RE]-';
const PERSON = 'su-ticket-admission-test';

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let startedAt: Date;
let registry: ProviderRegistry;
let issues: Array<Record<string, unknown>>;

function issue(n: number, title: string, assignees: string[], updatedAt = '2026-10-01T10:00:00Z'): Record<string, unknown> {
  return {
    id: 7000 + n, number: n, title, body: `body of #${n}`, state: 'open', user: { login: 'alice-gh' },
    assignees: assignees.map((login) => ({ login })), labels: [],
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${n}`,
    created_at: '2026-10-01T08:00:00Z', updated_at: updatedAt,
  };
}

function json(body: unknown): HostFetchResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

/** Recorded GitHub: one page of issues, no events or comments; enough for admission. */
const githubFetch: HostFetch = async ({ request }) => {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get('page') ?? '1');
  if (page > 1 || !url.pathname.endsWith('/issues')) return json([]);
  return json(issues);
};

/**
 * GitHub's documented "Create an issue comment" response (201; the same schema as "Get an issue
 * comment"), read from docs.github.com/en/rest/issues/comments on 2026-10-06: every top-level field
 * the schema marks required, with its documented JSON type. `user` is "any of: null, Simple User".
 * The recorded write below is calibrated against this, so the provider parses a faithful body.
 */
const GITHUB_ISSUE_COMMENT_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  id: ['number'], node_id: ['string'], url: ['string'], html_url: ['string'], user: ['null', 'object'],
  created_at: ['string'], updated_at: ['string'], issue_url: ['string'],
};

/** Recorded GitHub: the 201 body of a created issue comment. */
function recordedGithubComment(issueNumber: number, id: number, body: string): Record<string, unknown> {
  return {
    id,
    node_id: `IC_kwDOAcmeTulip${id}`,
    url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/comments/${id}`,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${issueNumber}#issuecomment-${id}`,
    body,
    user: null,
    created_at: '2026-10-06T06:00:00Z',
    updated_at: '2026-10-06T06:00:00Z',
    issue_url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/${issueNumber}`,
    author_association: 'NONE',
  };
}

// ── A writable ticket provider (GitHub declares ticket.comment only, D-008) ──

const writableDescriptor: ProviderDescriptor = {
  id: WRITABLE,
  contractVersion: 1,
  datatypes: ['ticket'],
  capabilities: ['ticket.read', 'ticket.comment', 'ticket.transition'],
  egressHosts: ['tickets.example.com'],
};
const invoked: Array<{ request: ProviderInvokeRequest; fetched: string | null }> = [];
/** The fixture tracker's current column, so a repeated move reports `changed: false`. */
let fixtureCategory = 'todo';
const writableAdapter: ProviderAdapter = {
  describe: () => writableDescriptor,
  syncPage: async () => ({
    records: [{
      datatype: 'ticket',
      nativeId: 'TIX-9',
      event: 'ticket-updated',
      payload: { provider: 'fixture', externalId: 'TIX-9', title: 'Writable ticket', body: 'b', state: 'open', assignees: [], labels: [] },
    }],
    nextCursor: null,
    hasMore: false,
  }),
  invoke: async (request, host) => {
    const path = request.capability === 'ticket.transition' ? 'state' : 'comments';
    const response = await host.fetch({
      source: request.source,
      request: { url: `https://tickets.example.com/TIX-9/${path}`, method: 'POST', body: JSON.stringify(request.args) },
    });
    invoked.push({ request, fetched: response.body });
    if (request.capability === 'ticket.transition') {
      const to = String(request.args.toCategory);
      if (to === fixtureCategory) return { changed: false };
      fixtureCategory = to;
      return { changed: true, updateId: `history:${to}-1` };
    }
    return { externalRef: 'comment-77', updateId: 'comment:77' };
  },
};

/** A tracker that only reads: no ticket.comment, no ticket.transition. */
const READ_ONLY = 'ticket-readonly-fixture';
const readOnlyDescriptor: ProviderDescriptor = {
  id: READ_ONLY,
  contractVersion: 1,
  datatypes: ['ticket'],
  capabilities: ['ticket.read'],
  egressHosts: ['readonly.example.com'],
};
const readOnlyInvoke = vi.fn(async () => ({ ticket: {} }));
const readOnlyAdapter: ProviderAdapter = {
  describe: () => readOnlyDescriptor,
  syncPage: async () => ({
    records: [{
      datatype: 'ticket',
      nativeId: 'RO-1',
      event: 'ticket-updated',
      payload: { provider: 'fixture', externalId: 'RO-1', title: 'Read-only ticket', body: 'b', state: 'open', assignees: [], labels: [] },
    }],
    nextCursor: null,
    hasMore: false,
  }),
  invoke: readOnlyInvoke,
};

async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

/** One pass of the shared driver over one source, with the default datatype sinks. */
async function sync(sourceId: string, hostFetch: HostFetch = githubFetch): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
  const result = await runConnectorSync(
    sql,
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId] },
    { registry, ingest, hostFetchFor: () => hostFetch, leaseOwner: 'ticket-admission-it' },
  );
  expect(result.sources).toEqual([expect.objectContaining({ sourceId, outcome: 'synced', rejected: 0 })]);
}

/** The data source's config; write-back hands it to the provider as `syncPage` gets it. */
const SOURCE_CONFIG = { owner: OWNER, repo: REPO, harnessSlug: HARNESS };

async function connect(kind = GITHUB, config: Record<string, unknown> = SOURCE_CONFIG): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${alice}, ${`${kind}-account-${Date.now()}`}, 'connected',
            ${sql.json(config as never)}, 'organization',
            ${sql.json({ ticket: ['record'], 'ticket-status-change': ['event'], 'ticket-comment': ['document'] })},
            ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  return row!.id;
}

interface AdmissionDb {
  work_item_id: string; source_kind: string; source_key: string; data_source_id: string | null;
  admitted_via: string; admitted_by: string; rule_id: string | null;
}

async function admissions(): Promise<AdmissionDb[]> {
  return sql<AdmissionDb[]>`
    SELECT work_item_id, source_kind, source_key, data_source_id::text AS data_source_id,
           admitted_via, admitted_by, rule_id::text AS rule_id
      FROM harness_shared.work_admissions
     WHERE workspace_id = ${WS}
       AND data_source_id IN (SELECT id FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${GITHUB}, ${WRITABLE}))
     ORDER BY created_at`;
}

/** Every non-connector work item this test minted, with its admission count. */
async function mintedWork(): Promise<Array<{ feature_id: string; created_by: string | null; admission_count: number }>> {
  return sql<Array<{ feature_id: string; created_by: string | null; admission_count: number }>>`
    SELECT w.feature_id, w.payload->'_ei'->>'created_by' AS created_by,
           (SELECT count(*)::int FROM harness_shared.work_admissions a
             WHERE a.workspace_id = w.workspace_id AND a.work_item_id = w.feature_id) AS admission_count
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${WS} AND w.feature_id !~ ${CONNECTOR_ROW_RE} AND w.created_ts >= ${startedAt.getTime()}
       AND EXISTS (SELECT 1 FROM harness_shared.work_admissions a
                    WHERE a.workspace_id = w.workspace_id AND a.work_item_id = w.feature_id
                      AND a.data_source_id IN (SELECT id FROM harness_shared.data_sources
                                                WHERE workspace_id = ${WS} AND kind IN (${GITHUB}, ${WRITABLE})))
     ORDER BY w.feature_id`;
}

async function clean(): Promise<void> {
  const sources = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${GITHUB}, ${WRITABLE}, ${READ_ONLY})`;
  const ids = sources.map((s) => s.id);
  if (ids.length > 0) {
    await sql`DELETE FROM harness_shared.admission_write_backs WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`
      DELETE FROM harness_shared.work_items w
       USING harness_shared.work_admissions a
       WHERE a.workspace_id = ${WS} AND w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
         AND a.data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`DELETE FROM harness_shared.admission_rules WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND metadata->>'dataSourceId' = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS} AND source_ref = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array(ids)}::uuid[])`;
  }
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${GITHUB}, ${WRITABLE}, ${READ_ONLY})`;
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`ticket-admission-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;

  // The real GitHub issues package, discovered and registered the way the host does it.
  const target = join(ROOT, 'project', 'plugins', 'github-issues');
  await fs.mkdir(target, { recursive: true });
  await fs.cp(PACKAGE_DIR, target, { recursive: true });
  const emptyGlobal = join(ROOT, 'no-global-plugins');
  await fs.mkdir(emptyGlobal, { recursive: true });
  const { loaded, errors } = await loadPlugins({ projectDir: join(ROOT, 'project'), harnessSlugs: [], globalPluginsDir: emptyGlobal });
  expect(errors).toEqual([]);
  registry = createProviderRegistry();
  expect(await registerPluginProviders(loaded, () => {}, registry)).toEqual([GITHUB]);
  // register() runs the production descriptor validator and throws on an invalid descriptor.
  await registry.register({ descriptor: writableDescriptor, adapter: writableAdapter, pluginName: WRITABLE, runtime: 'js' } as never);
  await registry.register({ descriptor: readOnlyDescriptor, adapter: readOnlyAdapter, pluginName: READ_ONLY, runtime: 'js' } as never);
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await clean();
  invoked.length = 0;
  fixtureCategory = 'todo';
  readOnlyInvoke.mockClear();
  startedAt = new Date(Date.now() - 1000);
});

describe('ticket admission into work (P-020, R-14) through the shared connector driver', () => {
  it('admits only tickets a rule matches, attributes every admission, and stays idempotent on re-sync', async () => {
    issues = [issue(1, 'Agents should fix the tulip build', ['papercusp-agents']), issue(2, 'Human-only ticket', ['carol-gh'])];
    const sourceId = await connect();
    const rule = await setAdmissionRule(
      { workspaceId: WS, dataSourceId: sourceId, title: 'Assigned to the agents user', match: { assignees: { contains: 'papercusp-agents' } }, harness: HARNESS, createdBy: PERSON },
      sql,
    );

    await sync(sourceId);

    const matchedRecord = dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#1`);
    const unmatchedRecord = dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#2`);
    const rows = await admissions();
    expect(rows).toEqual([
      {
        work_item_id: expect.any(String), source_kind: 'record', source_key: matchedRecord, data_source_id: sourceId,
        admitted_via: 'rule', admitted_by: `admission-rule:${rule.id}`, rule_id: rule.id,
      },
    ]);
    // The unmatched ticket is still only a record.
    expect(rows.some((r) => r.source_key === unmatchedRecord)).toBe(false);
    const [unmatched] = await sql<Array<{ nature: string }>>`
      SELECT nature FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${unmatchedRecord}`;
    expect(unmatched).toEqual({ nature: 'record' });

    const minted = await mintedWork();
    expect(minted).toEqual([{ feature_id: rows[0]!.work_item_id, created_by: `admission-rule:${rule.id}`, admission_count: 1 }]);
    const [item] = await sql<Array<{ title: string; nature: string }>>`
      SELECT title, nature FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${rows[0]!.work_item_id}`;
    // A rule admission carries outside text, so the work item stores its title quoted (P-013, D-047).
    expect(item).toEqual({ title: quoteEndUserTitle(`${OWNER}/${REPO}#1: Agents should fix the tulip build`), nature: 'work' });

    // A Papercusp-owned field set on the admitted item survives the re-sync below.
    await sql`UPDATE harness_shared.work_items SET taken_by = ${PERSON} WHERE workspace_id = ${WS} AND feature_id = ${rows[0]!.work_item_id}`;

    issues[0] = { ...issues[0]!, title: 'Agents should fix the tulip build (retitled)', updated_at: '2026-10-01T11:00:00Z' };
    await sync(sourceId);
    expect(await admissions()).toHaveLength(1);
    expect(await mintedWork()).toHaveLength(1);
    const [resynced] = await sql<Array<{ title: string; assignee: string | null }>>`
      SELECT title, taken_by AS assignee FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${rows[0]!.work_item_id}`;
    // The re-sync quotes exactly as the admission did.
    expect(resynced).toEqual({ title: quoteEndUserTitle(`${OWNER}/${REPO}#1: Agents should fix the tulip build (retitled)`), assignee: PERSON });
  });

  it('a person promotes an unmatched ticket by hand; a second promote returns the same admission', async () => {
    issues = [issue(3, 'Promote me by hand', [])];
    const sourceId = await connect();
    await sync(sourceId);
    const recordId = dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#3`);
    expect(await admissions()).toEqual([]);

    const promote = () =>
      admitWorkItem({ workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId }, admitter: { via: 'person', actorId: PERSON } }, { sql });
    const first = await promote();
    expect(first).toMatchObject({ ok: true, reason: 'admitted', linkedRecord: recordId });
    const second = await promote();
    expect(second).toMatchObject({ ok: true, reason: 'existing' });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.workItemId).toBe(first.workItemId);

    expect(await admissions()).toEqual([
      {
        work_item_id: first.workItemId, source_kind: 'record', source_key: recordId, data_source_id: sourceId,
        admitted_via: 'person', admitted_by: PERSON, rule_id: null,
      },
    ]);
    expect(await mintedWork()).toEqual([{ feature_id: first.workItemId, created_by: PERSON, admission_count: 1 }]);

    // Field authority: the source owns title and description; Papercusp-owned fields stay editable.
    expect(await refuseExternalOwnedPatch(WS, first.workItemId, ['title'], sql)).toMatchObject({
      code: 'field_owned_by_source', fields: ['title'],
    });
    expect(await refuseExternalOwnedPatch(WS, first.workItemId, ['body'], sql)).toMatchObject({ fields: ['body'] });
    expect(await refuseExternalOwnedPatch(WS, first.workItemId, ['priority', 'status'], sql)).toBeNull();
    // A work item that was never admitted has no external owner.
    expect(await refuseExternalOwnedPatch(WS, recordId, ['title'], sql)).toBeNull();
  });

  it('admits into one harness a record its source keeps in another, linking across them (WI-10006682)', async () => {
    // Records land in the source's config.harnessSlug; the work lands in the admitting harness.
    // Every other case here makes the two coincide, which hid this.
    const RECORD_HARNESS = 'ticket-admission-records';
    issues = [issue(6, 'Records live elsewhere', ['papercusp-agents'])];
    const sourceId = await connect(GITHUB, { ...SOURCE_CONFIG, harnessSlug: RECORD_HARNESS });
    await sync(sourceId);
    const recordId = dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#6`);
    const [record] = await sql<Array<{ harness_slug: string }>>`
      SELECT harness_slug FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${recordId}`;
    expect(record).toEqual({ harness_slug: RECORD_HARNESS });

    const admitted = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId }, admitter: { via: 'person', actorId: PERSON } },
      { sql },
    );
    expect(admitted).toMatchObject({ ok: true, reason: 'admitted', linkedRecord: recordId });
    if (!admitted.ok) throw new Error('unreachable');
    const [work] = await sql<Array<{ harness_slug: string }>>`
      SELECT harness_slug FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${admitted.workItemId}`;
    expect(work).toEqual({ harness_slug: HARNESS });
    expect(await admissions()).toEqual([expect.objectContaining({ work_item_id: admitted.workItemId, source_key: recordId, data_source_id: sourceId })]);
  });

  it('refuses a rule admission outside the rule’s data source and never admits an event row', async () => {
    issues = [issue(4, 'Scoped ticket', ['papercusp-agents'])];
    const sourceId = await connect();
    await sync(sourceId);
    const recordId = dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#4`);

    const foreignRule = await admitWorkItem(
      {
        workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId },
        admitter: { via: 'rule', ruleId: '00000000-0000-4000-8000-000000000001', dataSourceId: '00000000-0000-4000-8000-000000000002' },
      },
      { sql },
    );
    expect(foreignRule).toMatchObject({ ok: false, code: 'outside_rule_scope' });

    const [event] = await sql<Array<{ feature_id: string }>>`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id ~ '^DSE-' AND payload->>'dataSourceId' = ${sourceId} LIMIT 1`;
    expect(event).toBeDefined();
    const notRecord = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId: event!.feature_id }, admitter: { via: 'person', actorId: PERSON } },
      { sql },
    );
    expect(notRecord).toMatchObject({ ok: false, code: 'not_a_record' });

    expect(await admissions()).toEqual([]);
    expect(await mintedWork()).toEqual([]);
  });
});

describe('record write-back dispatches by provider capability (D-015.5)', () => {
  it('refuses a transition on GitHub, which has no workflow columns, without building a host.fetch', async () => {
    issues = [issue(5, 'Columnless ticket', [])];
    const sourceId = await connect();
    await sync(sourceId);
    const recordId = dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#5`);
    const admitted = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId }, admitter: { via: 'person', actorId: PERSON } },
      { sql },
    );
    if (!admitted.ok) throw new Error(`admission failed: ${JSON.stringify(admitted)}`);
    const [admission] = await admissionsForWorkItem(WS, admitted.workItemId, sql);
    expect(admission).toBeDefined();

    const hostFetchFor = vi.fn(() => githubFetch);
    await expect(createRecordAdmissionSource({ registry, hostFetchFor }).transition!({ db: sql, admission: admission!, toCategory: 'in-progress' }))
      .rejects.toThrow(`provider_capability_unsupported:${GITHUB}:ticket.transition`);
    expect(hostFetchFor).not.toHaveBeenCalled();
  });

  it('invokes ticket.comment on a provider that declares it, through a host.fetch bound to the record’s source', async () => {
    const sourceId = await connect(WRITABLE);
    await sync(sourceId);
    const recordId = dataSourceRecordId(WS, sourceId, 'ticket', 'TIX-9');
    const admitted = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId }, admitter: { via: 'person', actorId: PERSON } },
      { sql },
    );
    if (!admitted.ok) throw new Error(`admission failed: ${JSON.stringify(admitted)}`);
    const [admission] = await admissionsForWorkItem(WS, admitted.workItemId, sql);

    const bound: unknown[] = [];
    const hostFetchFor = (_db: unknown, input: { workspaceId: string; providerId: string; sourceId: string; harness: string }): HostFetch => {
      bound.push(input);
      return async ({ source, request }) => {
        // The host.fetch only ever serves the source it was bound to.
        expect(source).toBe(input.sourceId);
        return { status: 201, headers: {}, body: `posted:${request.body}`, bodyEncoding: 'utf8' };
      };
    };
    const result = await createRecordAdmissionSource({ registry, hostFetchFor }).writeBack!({ db: sql, admission: admission!, text: 'triaged' });
    expect(result).toEqual({ posted: true, externalRef: 'comment-77', updateId: 'comment:77' });
    expect(bound).toEqual([{ workspaceId: WS, providerId: WRITABLE, sourceId, harness: HARNESS }]);
    expect(invoked).toEqual([{
      // The source's config rides along, as syncPage gets it (linear-asana-task-sync P-005).
      request: { source: sourceId, capability: 'ticket.comment', args: { externalId: 'TIX-9', text: 'triaged' }, config: SOURCE_CONFIG },
      fetched: `posted:${JSON.stringify({ externalId: 'TIX-9', text: 'triaged' })}`,
    }]);
  });
});

describe('ticket write-back requested by work-item id (linear-asana-task-sync P-002)', () => {
  const bound: Array<{ workspaceId: string; providerId: string; sourceId: string; harness: string }> = [];
  const hostFetchFor = vi.fn((_db: unknown, input: { workspaceId: string; providerId: string; sourceId: string; harness: string }): HostFetch => {
    bound.push(input);
    return async ({ source, request }) => {
      // The host.fetch only ever serves the source it was bound to.
      expect(source).toBe(input.sourceId);
      return { status: 201, headers: {}, body: `posted:${request.body}`, bodyEncoding: 'utf8' };
    };
  });
  /** The resolver the verbs use, over this test's registry and host.fetch. */
  const deps = {
    resolverFor: (kind: string) => (kind === 'record' ? createRecordAdmissionSource({ registry, hostFetchFor }) : undefined),
  } as Parameters<typeof writeBackAdmission>[4];

  beforeEach(() => {
    bound.length = 0;
    hostFetchFor.mockClear();
  });

  async function admitFrom(kind: string, nativeId: string): Promise<{ sourceId: string; workItemId: string }> {
    const sourceId = await connect(kind);
    await sync(sourceId);
    const recordId = dataSourceRecordId(WS, sourceId, 'ticket', nativeId);
    const admitted = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId }, admitter: { via: 'person', actorId: PERSON } },
      { sql },
    );
    if (!admitted.ok) throw new Error(`admission failed: ${JSON.stringify(admitted)}`);
    return { sourceId, workItemId: admitted.workItemId };
  }

  it('delivers a comment through the source provider’s ticket.comment and ledgers the provider’s update id', async () => {
    const { sourceId, workItemId } = await admitFrom(WRITABLE, 'TIX-9');

    const res = await writeBackAdmission(WS, workItemId, '  picked up by Papercusp  ', sql, deps);

    expect(res).toEqual({ ok: true, sourceKind: 'record', posted: true, externalRef: 'comment-77', updateId: 'comment:77' });
    // Resolved from the record's data source, invoked through a host.fetch bound to it alone.
    expect(bound).toEqual([{ workspaceId: WS, providerId: WRITABLE, sourceId, harness: HARNESS }]);
    expect(invoked.map((i) => i.request)).toEqual([
      { source: sourceId, capability: 'ticket.comment', args: { externalId: 'TIX-9', text: 'picked up by Papercusp' }, config: SOURCE_CONFIG },
    ]);
    expect(await writeBacksForWorkItem(sql, WS, workItemId)).toEqual([
      expect.objectContaining({ workItemId, dataSourceId: sourceId, action: 'comment', updateId: 'comment:77', externalRef: 'comment-77', detail: {} }),
    ]);
    // Echo suppression: the provider's id for this change finds the host's own write, and only it.
    expect(await findAdmissionWriteBack(sql, { workspaceId: WS, dataSourceId: sourceId, updateId: 'comment:77' }))
      .toMatchObject({ workItemId, action: 'comment' });
    expect(await findAdmissionWriteBack(sql, { workspaceId: WS, dataSourceId: sourceId, updateId: 'comment:78' })).toBeNull();
    const other = await connect(WRITABLE);
    expect(await findAdmissionWriteBack(sql, { workspaceId: WS, dataSourceId: other, updateId: 'comment:77' })).toBeNull();
  });

  it('refuses a provider without the capability by name, before any host.fetch or provider call, and ledgers nothing', async () => {
    const { workItemId } = await admitFrom(READ_ONLY, 'RO-1');

    expect(await writeBackAdmission(WS, workItemId, 'picked up', sql, deps)).toEqual({
      ok: false,
      code: 'provider_capability_unsupported',
      message: `provider_capability_unsupported:${READ_ONLY}:ticket.comment`,
    });
    expect(await transitionAdmission(WS, workItemId, 'done', sql, deps)).toEqual({
      ok: false,
      code: 'provider_capability_unsupported',
      message: `provider_capability_unsupported:${READ_ONLY}:ticket.transition`,
    });
    expect(hostFetchFor).not.toHaveBeenCalled();
    expect(readOnlyInvoke).not.toHaveBeenCalled();
    expect(await writeBacksForWorkItem(sql, WS, workItemId)).toEqual([]);
  });

  it('moves the source to a workflow category sending only the category, and recognises its own move', async () => {
    const { sourceId, workItemId } = await admitFrom(WRITABLE, 'TIX-9');

    expect(await transitionAdmission(WS, workItemId, 'in-progress', sql, deps)).toEqual({
      ok: true, sourceKind: 'record', toCategory: 'in-progress', transitioned: true, updateId: 'history:in-progress-1', externalRef: null,
    });
    // Field authority (D-004): title, description and assignee never travel; only the category does.
    expect(invoked.map((i) => i.request)).toEqual([
      { source: sourceId, capability: 'ticket.transition', args: { externalId: 'TIX-9', toCategory: 'in-progress' }, config: SOURCE_CONFIG },
    ]);

    // Already there: the provider changes nothing, and nothing is ledgered for it.
    expect(await transitionAdmission(WS, workItemId, 'in-progress', sql, deps)).toMatchObject({ ok: true, transitioned: false });
    expect(await writeBacksForWorkItem(sql, WS, workItemId)).toEqual([
      // `changed` records whether the provider actually moved the task (P-003 lifecycle reads it).
      expect.objectContaining({ action: 'transition', updateId: 'history:in-progress-1', detail: { toCategory: 'in-progress', changed: true } }),
    ]);
    expect(await findAdmissionWriteBack(sql, { workspaceId: WS, dataSourceId: sourceId, updateId: 'history:in-progress-1' }))
      .toMatchObject({ workItemId, action: 'transition', detail: { toCategory: 'in-progress' } });

    // An unknown category is refused before any provider call.
    const calls = invoked.length;
    expect(await transitionAdmission(WS, workItemId, 'shipped', sql, deps)).toMatchObject({ ok: false, code: 'transition_category_invalid' });
    expect(invoked).toHaveLength(calls);
  });

  it('posts a comment on a GitHub-admitted issue through the real package, ledgered under the comment sync’s nativeId (WI-10006212)', async () => {
    issues = [issue(5, 'Commentable ticket', [])];
    const sourceId = await connect();
    await sync(sourceId);
    const admitted = await admitWorkItem(
      {
        workspaceId: WS, harness: HARNESS,
        source: { kind: 'record', recordId: dataSourceRecordId(WS, sourceId, 'ticket', `${OWNER}/${REPO}#5`) },
        admitter: { via: 'person', actorId: PERSON },
      },
      { sql },
    );
    if (!admitted.ok) throw new Error(`admission failed: ${JSON.stringify(admitted)}`);
    const posted: Array<{ source: string; url: string; method?: string; body: unknown }> = [];
    const recordedGithubWrite = (_db: unknown, input: { sourceId: string }): HostFetch => async ({ source, request }) => {
      expect(source).toBe(input.sourceId);
      posted.push({ source, url: request.url, method: request.method, body: JSON.parse(String(request.body)) });
      return {
        status: 201, headers: { 'content-type': 'application/json' }, bodyEncoding: 'utf8',
        body: JSON.stringify(recordedGithubComment(5, 4242, String((JSON.parse(String(request.body)) as { body?: unknown }).body ?? ''))),
      };
    };
    const githubDeps = {
      resolverFor: (kind: string) => (kind === 'record' ? createRecordAdmissionSource({ registry, hostFetchFor: recordedGithubWrite }) : undefined),
    } as Parameters<typeof writeBackAdmission>[4];

    expect(await writeBackAdmission(WS, admitted.workItemId, 'Papercusp picked this up.', sql, githubDeps)).toEqual({
      ok: true, sourceKind: 'record', posted: true,
      externalRef: `https://github.com/${OWNER}/${REPO}/issues/5#issuecomment-4242`, updateId: 'comment:4242',
    });
    expect(posted).toEqual([{
      source: sourceId, url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/5/comments`, method: 'POST',
      body: { body: 'Papercusp picked this up.' },
    }]);
    // The next comment sync reports this comment as nativeId `comment:4242`: the host knows it is its own.
    expect(await findAdmissionWriteBack(sql, { workspaceId: WS, dataSourceId: sourceId, updateId: 'comment:4242' }))
      .toMatchObject({ workItemId: admitted.workItemId, action: 'comment' });
    // GitHub has no workflow columns: a transition is refused by name, before any request.
    expect(await transitionAdmission(WS, admitted.workItemId, 'in-progress', sql, githubDeps)).toEqual({
      ok: false, code: 'provider_capability_unsupported', message: `provider_capability_unsupported:${GITHUB}:ticket.transition`,
    });
    expect(posted).toHaveLength(1);
  });

  it('runs on calibrated fixtures: the fixture providers pass the production descriptor validator and the recorded GitHub comment carries every documented required field', async () => {
    expect(validateProviderDescriptor(writableDescriptor)).toEqual([]);
    expect(validateProviderDescriptor(readOnlyDescriptor)).toEqual([]);
    const recorded = recordedGithubComment(5, 4242, 'x');
    const typeOf = (v: unknown) => (v === null ? 'null' : typeof v);
    for (const [field, types] of Object.entries(GITHUB_ISSUE_COMMENT_REQUIRED)) {
      expect({ field, present: field in recorded, type: types.includes(typeOf(recorded[field])) }).toEqual({ field, present: true, type: true });
    }
    expect(Number.isInteger(recorded.id)).toBe(true);
  });

  it('refuses a work item that was never admitted from a data source', async () => {
    expect(await writeBackAdmission(WS, 'WI-never-admitted-p002', 'hello', sql, deps)).toMatchObject({ ok: false, code: 'not_admitted' });
    expect(await transitionAdmission(WS, 'WI-never-admitted-p002', 'done', sql, deps)).toMatchObject({ ok: false, code: 'not_admitted' });
    expect(hostFetchFor).not.toHaveBeenCalled();
  });
});
