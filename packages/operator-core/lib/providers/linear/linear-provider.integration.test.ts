/**
 * R-4 — Linear as a ticket provider on the integration contract
 * (plan linear-asana-task-sync-2026-10-05, P-004; decisions D-005, D-008, D-010).
 *
 * The REAL bundled package (`libs/papercusp/plugins/linear`) is discovered by the real plugin
 * loader and registered by the host's `registerPluginProviders`, then driven by the ONE shared
 * connector driver (`runConnectorSync`) with its DEFAULT sinks against a recorded Linear GraphQL
 * endpoint served through the provider's only network path, `host.fetch`. The recorded objects and
 * the variables the provider sends are typed with `@linear/sdk`'s generated schema types, so a
 * field or filter name Linear's schema does not have fails the typecheck, not a live sync.
 *
 * R-4 is the core claim: across two real-driver passes, with an issue edited, moved to done and
 * moved to another team in between, every Linear issue is exactly ONE ticket record, updated in
 * place. Also: issue history becomes ticket-status-change events linked to their ticket; comments
 * become ticket-comment documents; a replayed pass dedupes; a rate limit keeps the uncommitted
 * cursor; an interrupted pass resumes from the committed page; and both writes the host dispatches
 * by capability (`ticket.comment`, `ticket.transition`) reach Linear through host.fetch and come
 * back through the next sync as the same objects.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { LinearDocument as L } from '@linear/sdk';
import type { HostFetch, HostFetchResponse } from '@papercusp/plugin-sdk';
import { loadPlugins } from '@papercusp/plugin-loader';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../../plugin-host-runtime';
import { createProviderRegistry, type ProviderRegistry, type RegisteredProvider } from '../../integrations/provider-registry';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../../external-triggers/ingestion';
import { VAULT_DATATYPES } from '../../personal-vault/live-sink';
import { DATATYPE_FOR_APP } from '../../app-data-producer/app-rows';
import { dataSourceRecordId } from '../../data-sources/datatype-destination-sink';
import {
  createRecordAdmissionSource,
  recordTransitionCapability,
  recordWriteBackCapability,
} from '../../work-admission/record-source';
import { runConnectorSync, type ConnectorSyncDeps, type ConnectorSourceOutcome } from '../connector-runtime';
import { setAdmissionRuleAndBackfill, ticketRulePreset, type TicketRulePreset } from '../../work-admission/admission-rules';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// createWorkItem / mergeWorkItemPayload read in the operator's active workspace; pin it to the
// workspace the ticket datatype rows live in.
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = join(REPO_ROOT, 'libs/papercusp/plugins/linear');
const ROOT = join(tmpdir(), `papercusp-linear-it-${process.pid}-${Date.now()}`);

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const KIND = 'linear';
const API = 'https://api.linear.app/graphql';
const TICKET_DATATYPES = ['ticket', 'ticket-status-change', 'ticket-comment'];
const DESTINATIONS = { ticket: ['record'], 'ticket-status-change': ['event'], 'ticket-comment': ['document'] };

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let registry: ProviderRegistry;
let provider: RegisteredProvider;

// ── Linear's schema, as it crosses the wire ─────────────────────────────────
//
// Every name below is checked against @linear/sdk's generated schema types: `Pick` refuses a key
// the SDK type lacks, and `Rel` does the same for a relation whose node shape is narrowed here.

/** A DateTime scalar is typed `Date` by the SDK and travels as an ISO string. */
type WireScalar<V> = V extends Date ? string : V;
type Wire<T> = { [K in keyof T]: WireScalar<T[K]> };
/** Relation `K` of SDK type `T`, narrowed to the selection the provider makes. */
type Rel<T, K extends keyof T, V> = { [P in K]: V };

type UserNode = Pick<L.User, 'id' | 'name' | 'displayName'>;
type StateNode = Pick<L.WorkflowState, 'id' | 'name' | 'type' | 'position'>;
type TeamRef = Pick<L.Team, 'id' | 'key'>;
type HistoryNode = Wire<Pick<L.IssueHistory, 'id' | 'createdAt'>>
  & Rel<L.IssueHistory, 'fromState' | 'toState', StateNode | null>
  & Rel<L.IssueHistory, 'actor', UserNode | null>;
type IssueNode = Wire<Pick<L.Issue,
  | 'id' | 'identifier' | 'number' | 'title' | 'description' | 'url' | 'priority' | 'priorityLabel'
  | 'estimate' | 'dueDate' | 'createdAt' | 'updatedAt' | 'completedAt' | 'canceledAt'>>
  & Rel<L.Issue, 'state', StateNode>
  & Rel<L.Issue, 'team', TeamRef>
  & Rel<L.Issue, 'assignee' | 'delegate' | 'creator', UserNode | null>
  & Rel<L.Issue, 'parent', Pick<L.Issue, 'id'> | null>
  & Rel<L.Issue, 'project', Pick<L.Project, 'id' | 'name'> | null>
  & Rel<L.Issue, 'labels', { nodes: Array<Pick<L.IssueLabel, 'name'>> }>
  & Rel<L.Issue, 'history', { nodes: HistoryNode[] }>;
type CommentNode = Wire<Pick<L.Comment, 'id' | 'body' | 'url' | 'createdAt' | 'updatedAt'>>
  & Rel<L.Comment, 'user', UserNode | null>
  & Rel<L.Comment, 'issue', Pick<L.Issue, 'id'> | null>;

/** The variables each operation the provider sends must satisfy. */
type IssuesVars = Pick<L.QueryIssuesArgs, 'filter' | 'after'>;
type CommentsVars = Pick<L.QueryCommentsArgs, 'filter' | 'after'>;
type CommentCreateVars = { input: L.CommentCreateInput };
type IssueUpdateVars = { id: string; input: L.IssueUpdateInput };

// ── Recorded Linear ─────────────────────────────────────────────────────────

const PAPERCUSP_APP: UserNode = { id: 'u-app', name: 'papercusp', displayName: 'Papercusp' };
const BOB: UserNode = { id: 'u-bob', name: 'bob', displayName: 'Bob' };
const ALICE: UserNode = { id: 'u-alice', name: 'alice', displayName: 'Alice' };

function states(prefix: string, rows: Array<[string, string]>): StateNode[] {
  return rows.map(([name, type], position) => ({ id: `${prefix}-${name.toLowerCase().replace(/\s+/g, '-')}`, name, type, position }));
}

const ENG_STATES = states('eng', [
  ['Triage', 'triage'], ['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'],
  ['In Review', 'started'], ['Done', 'completed'], ['Canceled', 'canceled'],
]);
const OPS_STATES = states('ops', [['Todo', 'unstarted'], ['Doing', 'started'], ['Done', 'completed']]);
const ENG: TeamRef = { id: 'team-eng', key: 'ENG' };
const OPS: TeamRef = { id: 'team-ops', key: 'OPS' };
const TEAM_STATES: Record<string, StateNode[]> = { [ENG.id]: ENG_STATES, [OPS.id]: OPS_STATES };

function st(team: StateNode[], name: string): StateNode {
  const found = team.find((s) => s.name === name);
  if (!found) throw new Error(`fixture state ${name} missing`);
  return found;
}

function issue(over: Partial<IssueNode> & Pick<IssueNode, 'id' | 'identifier' | 'number' | 'title' | 'createdAt' | 'updatedAt' | 'state' | 'team'>): IssueNode {
  return {
    description: null, url: `https://linear.app/acme/issue/${over.identifier}`, priority: 0, priorityLabel: 'No priority',
    estimate: null, dueDate: null, completedAt: null, canceledAt: null,
    assignee: null, delegate: null, creator: ALICE, parent: null, project: null,
    labels: { nodes: [] }, history: { nodes: [] },
    ...over,
  };
}

interface Recorded {
  issues: IssueNode[];
  comments: CommentNode[];
  /** Every operation, in order, with the variables the provider sent. */
  calls: Array<{ op: string; variables: Record<string, unknown> }>;
  /** Operation -> seconds until Linear's limit resets, for the next request of that operation (consumed once). */
  rateLimitOnce: Map<string, number>;
  /** Linear decides page size; the fake uses a small one so pagination is exercised. */
  pageSize: number;
  nextId: number;
}

let lin: Recorded;

function recorded(): Recorded {
  return {
    calls: [],
    rateLimitOnce: new Map(),
    pageSize: 2,
    nextId: 1,
    issues: [
      issue({
        id: 'iss-1', identifier: 'ENG-1', number: 1, title: 'Cold start fails', description: 'Steps attached.',
        priority: 2, priorityLabel: 'High', estimate: 3, dueDate: '2026-10-09',
        createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z',
        state: st(ENG_STATES, 'In Progress'), team: ENG, assignee: BOB, delegate: PAPERCUSP_APP,
        labels: { nodes: [{ name: 'bug' }] },
        history: { nodes: [{
          id: 'h-1', createdAt: '2026-10-01T09:00:00.000Z',
          fromState: st(ENG_STATES, 'Todo'), toState: st(ENG_STATES, 'In Progress'), actor: BOB,
        }] },
      }),
      issue({
        id: 'iss-2', identifier: 'ENG-2', number: 2, title: 'Flaky deploy check',
        createdAt: '2026-10-01T08:10:00.000Z', updatedAt: '2026-10-01T08:10:00.000Z', state: st(ENG_STATES, 'Todo'), team: ENG,
      }),
      issue({
        id: 'iss-3', identifier: 'ENG-3', number: 3, title: 'Runbook is stale',
        createdAt: '2026-10-01T08:20:00.000Z', updatedAt: '2026-10-01T08:20:00.000Z', state: st(ENG_STATES, 'Backlog'), team: ENG,
      }),
      issue({
        id: 'iss-4', identifier: 'OPS-1', number: 1, title: 'Rotate certificates',
        createdAt: '2026-10-01T09:30:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', state: st(OPS_STATES, 'Doing'), team: OPS,
        history: { nodes: [{
          id: 'h-4', createdAt: '2026-10-01T10:00:00.000Z',
          fromState: st(OPS_STATES, 'Todo'), toState: st(OPS_STATES, 'Doing'), actor: ALICE,
        }] },
      }),
    ],
    comments: [
      {
        id: 'c-1', body: 'repro: the cache is cold after deploy', url: 'https://linear.app/acme/issue/ENG-1#comment-c1',
        createdAt: '2026-10-01T09:30:00.000Z', updatedAt: '2026-10-01T09:30:00.000Z', user: BOB, issue: { id: 'iss-1' },
      },
      {
        id: 'c-2', body: 'on it', url: 'https://linear.app/acme/issue/OPS-1#comment-c2',
        createdAt: '2026-10-01T10:30:00.000Z', updatedAt: '2026-10-01T10:30:00.000Z', user: ALICE, issue: { id: 'iss-4' },
      },
    ],
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

const data = (payload: unknown) => json(200, { data: payload });

/** The ISO instant of a DateComparator bound (the SDK types it `Date | string`). */
function bound(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** One page of a connection, newest first (Linear's updatedAt order), with an offset cursor. */
function connection<T extends { updatedAt: string }>(field: string, rows: T[], after: string | null | undefined, extra: Record<string, unknown> = {}) {
  const sorted = [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const offset = after ? Number(after.split(':')[1]) : 0;
  const nodes = sorted.slice(offset, offset + lin.pageSize);
  const end = offset + nodes.length;
  const hasNextPage = end < sorted.length;
  return data({ ...extra, [field]: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? `${field}:${end}` : null } } });
}

function issueById(id: string): IssueNode | undefined {
  return lin.issues.find((row) => row.id === id);
}

/** Recorded Linear GraphQL, served through the provider's ONLY network path. */
const recordedHostFetch: HostFetch = async ({ request }) => {
  expect(request.url).toBe(API);
  expect(request.method).toBe('POST');
  const { query, variables } = JSON.parse(String(request.body)) as { query: string; variables: Record<string, unknown> };
  const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?';
  lin.calls.push({ op, variables });
  const resetIn = lin.rateLimitOnce.get(op);
  if (resetIn !== undefined) {
    lin.rateLimitOnce.delete(op);
    return json(400, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED', type: 'ratelimited' } }] }, {
      'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': String(Date.now() + resetIn * 1000),
    });
  }
  switch (op) {
    case 'PapercuspIssues': {
      const { filter, after } = variables as IssuesVars;
      const team = filter?.team?.id?.eq;
      const since = bound(filter?.updatedAt?.gte);
      expect(team).toBeTruthy();
      const rows = lin.issues.filter((row) => row.team.id === team && (since === null || Date.parse(row.updatedAt) >= since));
      // The source is connected as Papercusp's app user (actor=app), so `viewer` is that user (D-012).
      return connection('issues', rows, after, { viewer: { id: PAPERCUSP_APP.id } });
    }
    case 'PapercuspComments': {
      const { filter, after } = variables as CommentsVars;
      const team = filter?.issue?.team?.id?.eq;
      const since = bound(filter?.updatedAt?.gte);
      expect(team).toBeTruthy();
      const rows = lin.comments.filter((row) => {
        const parent = row.issue ? issueById(row.issue.id) : undefined;
        return parent?.team.id === team && (since === null || Date.parse(row.updatedAt) >= since);
      });
      return connection('comments', rows, after);
    }
    case 'PapercuspIssue':
      return data({ viewer: { id: PAPERCUSP_APP.id }, issue: issueById(String(variables.id)) ?? null });
    case 'PapercuspIssueStates': {
      const row = issueById(String(variables.id));
      return data({ issue: row ? { id: row.id, state: row.state, team: { id: row.team.id, states: { nodes: TEAM_STATES[row.team.id] } } } : null });
    }
    case 'PapercuspCommentCreate': {
      const { input } = variables as CommentCreateVars;
      const parent = issueById(String(input.issueId));
      if (!parent) return json(200, { errors: [{ message: 'Entity not found', extensions: { type: 'invalid input' } }] });
      const id = `c-new-${lin.nextId++}`;
      const at = '2026-10-03T08:00:00.000Z';
      const comment: CommentNode = {
        id, body: String(input.body), url: `${parent.url}#comment-${id}`, createdAt: at, updatedAt: at, user: PAPERCUSP_APP, issue: { id: parent.id },
      };
      lin.comments.push(comment);
      return data({ commentCreate: { success: true, comment: { id, url: comment.url } } });
    }
    case 'PapercuspIssueTransition': {
      const { id, input } = variables as IssueUpdateVars;
      const row = issueById(id);
      const target = row && TEAM_STATES[row.team.id]!.find((s) => s.id === input.stateId);
      if (!row || !target) return json(200, { errors: [{ message: 'Entity not found', extensions: { type: 'invalid input' } }] });
      const at = '2026-10-03T09:00:00.000Z';
      row.history.nodes.push({ id: `h-new-${lin.nextId++}`, createdAt: at, fromState: row.state, toState: target, actor: PAPERCUSP_APP });
      row.state = target;
      row.updatedAt = at;
      if (target.type === 'completed') row.completedAt = at;
      return data({ issueUpdate: { success: true, issue: { id: row.id, updatedAt: at, state: target } } });
    }
    default:
      return json(400, { errors: [{ message: `unrecorded operation ${op}` }] });
  }
};

// ── Fixture plumbing ────────────────────────────────────────────────────────

/** Every event-bus emission is recorded instead of hitting the coord bus. */
async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

function deps(overrides: Partial<ConnectorSyncDeps> = {}): ConnectorSyncDeps {
  // `sinksFor` is deliberately NOT overridden: the driver's default datatype routing is under test.
  return { registry, ingest, hostFetchFor: () => recordedHostFetch, leaseOwner: 'linear-it', ...overrides };
}

async function syncOne(sourceId: string, opts: { maxPagesPerSource?: number } = {}): Promise<ConnectorSourceOutcome> {
  const result = await runConnectorSync(
    sql,
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId], pollIntervalSeconds: 300, ...opts },
    deps(),
  );
  expect(result.sources).toHaveLength(1);
  return result.sources[0]!;
}

async function createSource(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${KIND}, ${alice}, ${`linear-org-${Date.now()}`}, 'connected',
            ${sql.json({ teamIds: [ENG.id, OPS.id], harnessSlug: HARNESS })}, 'personal',
            ${sql.json(DESTINATIONS)}, ${sql.json({ mode: 'owner' })})
    RETURNING id::text`;
  return row!.id;
}

/** Make a source due again (the driver respects its poll cadence). */
async function due(sourceId: string): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
}

async function cursorOf(sourceId: string): Promise<{ raw: Record<string, unknown> | null; backfill: string | null; status: string; nextIn: number | null }> {
  const [row] = await sql<Array<{ provider: string | null; backfill_status: string | null; status: string; next_in: number | null }>>`
    SELECT cursor->>'provider' AS provider, backfill_status, status,
           EXTRACT(EPOCH FROM (sync_next_attempt_at - now()))::int AS next_in
      FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  return {
    raw: row!.provider ? (JSON.parse(row!.provider) as Record<string, unknown>) : null,
    backfill: row!.backfill_status,
    status: row!.status,
    nextIn: row!.next_in,
  };
}

interface Row {
  feature_id: string;
  kind: string;
  nature: string;
  agent_work: boolean;
  payload: Record<string, unknown>;
}

async function rows(sourceId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT feature_id, item_kind AS kind, nature,
           harness_shared.work_item_is_agent_work(nature, audience, lane, needs_owner_action) AS agent_work, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ${sourceId}
     ORDER BY item_kind, payload->>'externalId'`;
}

const tickets = async (sourceId: string) => (await rows(sourceId)).filter((r) => r.kind === 'ticket');
const changes = async (sourceId: string) => (await rows(sourceId)).filter((r) => r.kind === 'ticket-status-change');

async function docs(sourceId: string) {
  return sql<Array<{ kind: string; scope: string; user_id: string | null; external_id: string; text: string; metadata: Record<string, unknown> }>>`
    SELECT kind, scope, user_id::text, external_id, text, metadata
      FROM harness_shared.documents
     WHERE workspace_id = ${WS} AND metadata->>'dataSourceId' = ${sourceId}
     ORDER BY external_id`;
}

/** Sink kinds the real delivery ledger recorded, per datatype (from the version-scoped dedupe key). */
async function sinkKindsByDatatype(sourceId: string): Promise<Record<string, string[]>> {
  const ledger = await sql<Array<{ datatype: string; sink_kind: string; outcome: string }>>`
    SELECT split_part(dedupe_key, ':', 3) AS datatype, sink_kind, outcome
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid`;
  for (const entry of ledger) expect(entry).toMatchObject({ outcome: 'delivered' });
  const out: Record<string, Set<string>> = {};
  for (const { datatype, sink_kind } of ledger) (out[datatype] ??= new Set()).add(sink_kind);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** R-4 as a query: externalIds that more than one ticket row claims (must be empty). */
async function duplicatedTickets(sourceId: string): Promise<string[]> {
  const dupes = await sql<{ external_id: string }[]>`
    SELECT payload->>'externalId' AS external_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ${sourceId} AND item_kind = 'ticket'
     GROUP BY 1 HAVING count(*) > 1`;
  return dupes.map((d) => d.external_id);
}

async function clean(): Promise<void> {
  const sources = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${KIND}`;
  const ids = sources.map((s) => s.id);
  if (ids.length > 0) {
    // Admitted work items carry no dataSourceId of their own; they are found through their admission.
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
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${KIND}`;
}

/** Discover the real package the way the host does: a project `plugins/` dir holding it. */
async function discoverRealPackage() {
  const projectDir = join(ROOT, 'project');
  const target = join(projectDir, 'plugins', 'linear');
  await fs.mkdir(target, { recursive: true });
  await fs.cp(PACKAGE_DIR, target, { recursive: true });
  const emptyGlobal = join(ROOT, 'no-global-plugins');
  await fs.mkdir(emptyGlobal, { recursive: true });
  return loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir: emptyGlobal });
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`linear-provider-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;

  const { loaded, errors } = await discoverRealPackage();
  expect(errors).toEqual([]);
  registry = createProviderRegistry();
  const failures: ProviderRegistrationFailure[] = [];
  expect(await registerPluginProviders(loaded, (f) => failures.push(f), registry)).toEqual([KIND]);
  expect(failures).toEqual([]);
  provider = registry.get(KIND)!;
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  lin = recorded();
  await clean();
});

// ── Registration ────────────────────────────────────────────────────────────

describe('Linear registers as a provider through the plugin host (P-004)', () => {
  it('is a bundled package with the ticket datatypes, read + comment + transition, and an app-actor install', () => {
    // Production discovers bundled plugins at <repo>/libs/papercusp/plugins (findBundledPluginsParent).
    expect(existsSync(join(PACKAGE_DIR, 'papercusp.json'))).toBe(true);
    expect(provider.pluginName).toBe(KIND);
    expect(provider.runtime).toBe('js');
    expect(provider.descriptor.datatypes).toEqual(TICKET_DATATYPES);
    expect(provider.descriptor.capabilities).toEqual(['ticket.read', 'ticket.create', 'ticket.comment', 'ticket.transition', 'ticket.containers']);
    expect(provider.descriptor.egressHosts).toEqual(['api.linear.app', 'linear.app']);
    // D-005: Papercusp installs as its own Linear user and is delegated work, not assigned it.
    const oauth = provider.descriptor.oauth!;
    expect(new URL(oauth.authorizeUrl).searchParams.get('actor')).toBe('app');
    expect(oauth.scopes).toEqual(['read', 'write', 'app:assignable', 'app:mentionable']);
    expect(oauth.scopeSeparator).toBe(',');
    expect(oauth.identity).toMatchObject({ url: API, method: 'POST', idField: 'data.organization.id' });

    // The host's capability dispatch finds Linear for both ticket writes.
    expect(registry.forDatatype('ticket', recordWriteBackCapability('ticket')).map((p) => p.descriptor.id)).toEqual([KIND]);
    expect(registry.forDatatype('ticket', recordTransitionCapability('ticket')).map((p) => p.descriptor.id)).toEqual([KIND]);
    expect(registry.forDatatype('ticket', 'ticket.update')).toEqual([]);
  });

  it('serves ticket.read through host.fetch only', async () => {
    const sourceId = await createSource();
    const read = (await provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.read', args: { externalId: 'iss-1' } },
      { fetch: recordedHostFetch },
    )) as { ticket: Record<string, unknown> };
    expect(read.ticket).toMatchObject({
      externalId: 'iss-1', identifier: 'ENG-1', container: 'ENG', statusCategory: 'in-progress', delegates: ['Papercusp'],
      selfRoles: ['delegate'], // delegated to the connected app user (D-012)
    });
    expect(lin.calls.map((c) => c.op)).toEqual(['PapercuspIssue']);
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.read', args: { externalId: 'iss-missing' } },
      { fetch: recordedHostFetch },
    )).rejects.toThrow('ticket_not_found:iss-missing');
  });
});

// ── Sync through the shared driver ──────────────────────────────────────────

describe('Linear syncs through the shared connector driver (R-4)', () => {
  it('backfills tickets, status changes and comments for every configured team, routed by datatype', async () => {
    const sourceId = await createSource();
    const outcome = await syncOne(sourceId);
    // ENG issues (two pages of two), ENG comments, OPS issues, OPS comments.
    expect(outcome).toMatchObject({ providerId: KIND, outcome: 'synced', mode: 'backfill', pages: 5, hasMore: false, rejected: 0 });
    // 4 tickets + 4 `opened` + 2 history moves + 2 comments.
    expect(outcome.admitted).toBe(12);
    expect(await cursorOf(sourceId)).toMatchObject({ backfill: 'complete', status: 'connected' });

    const stored = await tickets(sourceId);
    expect(stored.map((r) => [r.nature, r.agent_work, r.payload.externalId, r.payload.identifier])).toEqual([
      ['record', false, 'iss-1', 'ENG-1'],
      ['record', false, 'iss-2', 'ENG-2'],
      ['record', false, 'iss-3', 'ENG-3'],
      ['record', false, 'iss-4', 'OPS-1'],
    ]);
    const eng1 = stored[0]!;
    // The ticket's id is keyed by the issue UUID, which survives a team move (ENG-3 -> OPS-2 below).
    expect(eng1.feature_id).toBe(dataSourceRecordId(WS, sourceId, 'ticket', 'iss-1'));
    expect(eng1.payload).toMatchObject({
      provider: 'linear', container: 'ENG', number: 1, title: 'Cold start fails', body: 'Steps attached.',
      state: 'open', statusCategory: 'in-progress', statusName: 'In Progress', assignees: ['Bob'], delegates: ['Papercusp'],
      labels: ['bug'], priority: { level: 2, name: 'High' }, estimate: 3, dueAt: '2026-10-09T00:00:00.000Z', author: 'Alice',
      dataSourceId: sourceId,
    });

    const moves = await changes(sourceId);
    expect(moves.map((r) => [r.nature, r.agent_work, r.payload.externalId, r.payload.transition])).toEqual([
      ['event', false, 'history:h-1', 'moved'],
      ['event', false, 'history:h-4', 'moved'],
      ['event', false, 'opened:iss-1', 'opened'],
      ['event', false, 'opened:iss-2', 'opened'],
      ['event', false, 'opened:iss-3', 'opened'],
      ['event', false, 'opened:iss-4', 'opened'],
    ]);
    expect(moves[0]!.payload).toMatchObject({
      ticketExternalId: 'iss-1', ticketWorkItemId: eng1.feature_id, fromCategory: 'todo', toCategory: 'in-progress',
      fromStatusName: 'Todo', toStatusName: 'In Progress', actor: 'Bob',
    });

    // Comments are documents in the owner's personal corpus, linked to their ticket.
    const comments = await docs(sourceId);
    expect(comments.map((d) => [d.kind, d.scope, d.user_id, d.external_id, d.text])).toEqual([
      ['ticket-comment', 'personal', alice, 'comment:c-1', 'repro: the cache is cold after deploy'],
      ['ticket-comment', 'personal', alice, 'comment:c-2', 'on it'],
    ]);
    expect(comments[0]!.metadata).toMatchObject({ ticketExternalId: 'iss-1', ticketWorkItemId: eng1.feature_id });

    // Routing by DATATYPE on the real delivery ledger: no ticket datatype reaches the Vault or an app sink.
    expect(TICKET_DATATYPES.some((d) => VAULT_DATATYPES.includes(d))).toBe(false);
    expect(TICKET_DATATYPES.some((d) => Object.values(DATATYPE_FOR_APP).includes(d))).toBe(false);
    const sinks = await sinkKindsByDatatype(sourceId);
    expect(sinks.ticket).toEqual(expect.arrayContaining(['data-source-record']));
    expect(sinks['ticket-status-change']).toEqual(expect.arrayContaining(['data-source-event']));
    expect(sinks['ticket-comment']).toEqual(expect.arrayContaining(['data-source-document']));
    for (const kinds of Object.values(sinks)) {
      expect(kinds).not.toContain('personal-vault');
      expect(kinds.filter((k) => k.startsWith('app'))).toEqual([]);
    }
  });

  it('R-4: one ticket per issue across two passes — an edit, a move to done and a team move all update in place', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const first = await tickets(sourceId);
    expect(first).toHaveLength(4);
    const idOf = (externalId: string) => first.find((r) => r.payload.externalId === externalId)!.feature_id;

    // Between passes, in Linear: ENG-2 is retitled and moved to Done; ENG-3 moves to the OPS team
    // (new identifier, same UUID); a new comment lands on ENG-1.
    const eng2 = issueById('iss-2')!;
    eng2.history.nodes.push({ id: 'h-2', createdAt: '2026-10-02T09:00:00.000Z', fromState: eng2.state, toState: st(ENG_STATES, 'Done'), actor: BOB });
    Object.assign(eng2, {
      title: 'Flaky deploy check (CI)', state: st(ENG_STATES, 'Done'), completedAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
    });
    const eng3 = issueById('iss-3')!;
    eng3.history.nodes.push({ id: 'h-3', createdAt: '2026-10-02T09:10:00.000Z', fromState: eng3.state, toState: st(OPS_STATES, 'Todo'), actor: ALICE });
    Object.assign(eng3, { team: OPS, identifier: 'OPS-2', number: 2, state: st(OPS_STATES, 'Todo'), updatedAt: '2026-10-02T09:10:00.000Z' });
    lin.comments.push({
      id: 'c-3', body: 'fixed on main', url: 'https://linear.app/acme/issue/ENG-1#comment-c3',
      createdAt: '2026-10-02T09:20:00.000Z', updatedAt: '2026-10-02T09:20:00.000Z', user: BOB, issue: { id: 'iss-1' },
    });
    lin.calls.length = 0;
    await due(sourceId);

    const second = await syncOne(sourceId);
    expect(second).toMatchObject({ outcome: 'synced', mode: 'incremental', rejected: 0, hasMore: false });
    // Two changed tickets, two new history moves, one new comment; the boundary re-reads dedupe.
    expect(second.admitted).toBe(5);
    // Each (team, phase) read carries the newest updatedAt the previous pass saw (inclusive).
    const filters = lin.calls.map((c) => [c.op, c.variables.filter]);
    expect(filters).toEqual([
      ['PapercuspIssues', { team: { id: { eq: ENG.id } }, updatedAt: { gte: '2026-10-01T09:00:00.000Z' } }],
      ['PapercuspComments', { issue: { team: { id: { eq: ENG.id } } }, updatedAt: { gte: '2026-10-01T09:30:00.000Z' } }],
      ['PapercuspIssues', { team: { id: { eq: OPS.id } }, updatedAt: { gte: '2026-10-01T10:00:00.000Z' } }],
      ['PapercuspComments', { issue: { team: { id: { eq: OPS.id } } }, updatedAt: { gte: '2026-10-01T10:30:00.000Z' } }],
    ]);

    const after = await tickets(sourceId);
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    expect(after.map((r) => r.feature_id).sort()).toEqual(first.map((r) => r.feature_id).sort());
    const moved = after.find((r) => r.feature_id === idOf('iss-3'))!;
    expect(moved.payload).toMatchObject({ externalId: 'iss-3', container: 'OPS', identifier: 'OPS-2', number: 2, statusCategory: 'todo' });
    const done = after.find((r) => r.feature_id === idOf('iss-2'))!;
    expect(done.payload).toMatchObject({
      title: 'Flaky deploy check (CI)', state: 'closed', statusCategory: 'done', closedAt: '2026-10-02T09:00:00.000Z',
    });

    const newMoves = (await changes(sourceId)).filter((r) => ['history:h-2', 'history:h-3'].includes(String(r.payload.externalId)));
    expect(newMoves.map((r) => [r.payload.externalId, r.payload.transition, r.payload.ticketWorkItemId])).toEqual([
      ['history:h-2', 'closed', idOf('iss-2')],
      ['history:h-3', 'moved', idOf('iss-3')],
    ]);
    expect((await changes(sourceId))).toHaveLength(8);
    expect((await docs(sourceId)).map((d) => d.external_id)).toEqual(['comment:c-1', 'comment:c-2', 'comment:c-3']);

    // Replay: nothing changed in Linear; the inclusive watermark re-reads the boundary objects and
    // the version-scoped dedupe absorbs them.
    await due(sourceId);
    const replay = await syncOne(sourceId);
    expect(replay).toMatchObject({ outcome: 'synced', admitted: 0, rejected: 0 });
    expect(replay.deduped).toBeGreaterThan(0);
    expect(await tickets(sourceId)).toHaveLength(4);
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    expect(await changes(sourceId)).toHaveLength(8);
    expect(await docs(sourceId)).toHaveLength(3);
  });

  it('a rate limit keeps the uncommitted cursor; an interrupted pass resumes from the committed page', async () => {
    const sourceId = await createSource();
    // Interrupted: one page allowed, so only the first ENG issues page is admitted and committed.
    const first = await syncOne(sourceId, { maxPagesPerSource: 1 });
    expect(first).toMatchObject({ outcome: 'synced', pages: 1, hasMore: true });
    expect((await cursorOf(sourceId)).raw).toMatchObject({ team: 0, phase: 'issues', after: 'issues:2' });
    expect((await tickets(sourceId)).map((r) => r.payload.externalId)).toEqual(['iss-1', 'iss-3']);

    // The next issues read is rate limited (Linear: HTTP 400 + RATELIMITED, reset header in epoch ms).
    lin.rateLimitOnce.set('PapercuspIssues', 120);
    lin.calls.length = 0;
    const limited = await syncOne(sourceId);
    expect(limited).toMatchObject({ outcome: 'rate-limited', pages: 0 });
    const afterLimit = await cursorOf(sourceId);
    expect(afterLimit.raw).toMatchObject({ team: 0, phase: 'issues', after: 'issues:2' });
    expect(afterLimit.nextIn).toBeGreaterThan(100);
    expect(afterLimit.nextIn).toBeLessThanOrEqual(121);
    expect(lin.calls).toEqual([{ op: 'PapercuspIssues', variables: { filter: { team: { id: { eq: ENG.id } } }, after: 'issues:2' } }]);

    // Resume: the pass continues from the second ENG page; the committed first page is never re-read.
    await due(sourceId);
    lin.calls.length = 0;
    const resumed = await syncOne(sourceId);
    expect(resumed).toMatchObject({ outcome: 'synced', pages: 4, hasMore: false });
    expect(lin.calls.filter((c) => c.op === 'PapercuspIssues' && !c.variables.after && (c.variables.filter as IssuesVars['filter'])?.team?.id?.eq === ENG.id)).toEqual([]);
    expect(await cursorOf(sourceId)).toMatchObject({ backfill: 'complete' });
    expect(await tickets(sourceId)).toHaveLength(4);
    expect(await changes(sourceId)).toHaveLength(6);
    expect(await docs(sourceId)).toHaveLength(2);
  });
});

// ── Writes dispatched by the host ───────────────────────────────────────────

describe('admission presets turn matching Linear issues into work (P-006, R-6)', () => {
  /** A different agent whose display name is ALSO "Papercusp": only the user id says who is who. */
  const LOOKALIKE: UserNode = { id: 'u-lookalike', name: 'papercusp-2', displayName: 'Papercusp' };

  type Admitted = { record: string; work_item_id: string; via: string; rule_id: string | null; kind: string; agent_work: boolean; about: number };
  /** Every admission of this source, with the work item it minted and its about-links to the record. */
  async function admitted(sourceId: string): Promise<Admitted[]> {
    return sql<Admitted[]>`
      SELECT a.source_key AS record, a.work_item_id, a.admitted_via AS via, a.rule_id::text AS rule_id,
             w.item_kind AS kind,
             harness_shared.work_item_is_agent_work(w.nature, w.audience, w.lane, w.needs_owner_action) AS agent_work,
             -- A feature-family destination is stored harness-qualified (papercusp#<id>).
             (SELECT count(*)::int FROM harness_shared.coord_links l
               WHERE l.src_ref = a.work_item_id AND l.rel = 'about'
                 AND (l.dst_ref = a.source_key OR l.dst_ref = ${HARNESS} || '#' || a.source_key)) AS about
        FROM harness_shared.work_admissions a
        JOIN harness_shared.work_items w ON w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
       WHERE a.workspace_id = ${WS} AND a.data_source_id = ${sourceId}::uuid
       ORDER BY a.source_key`;
  }
  const recordOf = (sourceId: string, issueId: string) => dataSourceRecordId(WS, sourceId, 'ticket', issueId);
  const preset = (sourceId: string, p: TicketRulePreset, value?: string) =>
    setAdmissionRuleAndBackfill(
      { workspaceId: WS, dataSourceId: sourceId, title: `${p} ${value ?? ''}`.trim(), match: ticketRulePreset(p, value), harness: HARNESS, createdBy: 'linear-it' },
      { sql },
    );

  it('delegated-to-papercusp: the delegated issue becomes exactly one linked work item, a bug; no other issue does', async () => {
    // ENG-2 is delegated to a lookalike agent named "Papercusp" too; ENG-3 and OPS-1 to nobody.
    lin.issues[1] = { ...lin.issues[1]!, delegate: LOOKALIKE };
    const sourceId = await createSource();
    const { rule, backfill } = await preset(sourceId, 'delegated-to-papercusp');
    expect(backfill).toEqual({ scanned: 0, admitted: 0, folded: 0, existing: 0, refused: [], truncated: false }); // nothing held yet

    await syncOne(sourceId);
    const rows1 = await admitted(sourceId);
    expect(rows1).toEqual([{
      record: recordOf(sourceId, 'iss-1'), work_item_id: expect.any(String), via: 'rule', rule_id: rule.id,
      kind: 'bug', // ENG-1 carries Linear's "bug" label
      agent_work: true, about: 1,
    }]);
    // The record itself stays data: only the admitted work item is agent work.
    expect((await tickets(sourceId)).map((t) => [t.payload.externalId, t.agent_work, t.payload.selfRoles ?? null])).toEqual([
      ['iss-1', false, ['delegate']], ['iss-2', false, null], ['iss-3', false, null], ['iss-4', false, null],
    ]);

    // An edit to the delegated issue and a full re-sync never mint a second work item.
    lin.issues[0] = { ...lin.issues[0]!, title: 'Cold start fails after deploy', updatedAt: '2026-10-02T09:00:00.000Z' };
    await due(sourceId);
    await syncOne(sourceId);
    expect(await admitted(sourceId)).toEqual(rows1);
  });

  it('a team rule added after the sync admits the issues already held, once; re-setting it admits nothing new', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    expect(await admitted(sourceId)).toEqual([]); // no rule, no work: every ticket stays a record

    const { rule, backfill } = await preset(sourceId, 'team', 'ops');
    expect(backfill).toMatchObject({ scanned: 4, admitted: 1, existing: 0, refused: [], truncated: false });
    const rows = await admitted(sourceId);
    expect(rows).toEqual([{
      record: recordOf(sourceId, 'iss-4'), work_item_id: expect.any(String), via: 'rule', rule_id: rule.id,
      kind: 'change', // OPS-1 has no bug label, so the rule's default kind
      agent_work: true, about: 1,
    }]);

    const again = await setAdmissionRuleAndBackfill(
      { workspaceId: WS, dataSourceId: sourceId, id: rule.id, title: rule.title, match: rule.match, harness: HARNESS, createdBy: 'linear-it' },
      { sql },
    );
    expect(again.backfill).toMatchObject({ scanned: 4, admitted: 0, existing: 1 });
    expect(await admitted(sourceId)).toEqual(rows);
  });

  it('a label rule admits only the labelled issue; a label no issue carries admits nothing', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    expect((await preset(sourceId, 'label', 'customer-reported')).backfill).toMatchObject({ scanned: 4, admitted: 0 });
    expect(await admitted(sourceId)).toEqual([]);
    expect((await preset(sourceId, 'label', 'BUG')).backfill).toMatchObject({ admitted: 1 });
    expect((await admitted(sourceId)).map((a) => [a.record, a.kind, a.about])).toEqual([[recordOf(sourceId, 'iss-1'), 'bug', 1]]);
  });
});

describe('the host writes back to Linear by capability (D-008)', () => {
  function admission(sourceId: string, externalId: string) {
    return {
      workspaceId: WS,
      dataSourceId: sourceId,
      sourceRef: { recordId: dataSourceRecordId(WS, sourceId, 'ticket', externalId), datatype: 'ticket', externalId },
    } as never;
  }

  it('ticket.comment posts only the text and its update id is the nativeId the next sync reads back', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const hostFetchFor = vi.fn(() => recordedHostFetch);
    const recordSource = createRecordAdmissionSource({ registry, hostFetchFor });
    lin.calls.length = 0;

    const posted = await recordSource.writeBack!({ db: sql as never, admission: admission(sourceId, 'iss-1'), text: '  Picked up by Papercusp.  ' } as never);
    expect(posted).toMatchObject({ posted: true, updateId: 'comment:c-new-1' });
    expect(lin.calls).toEqual([{ op: 'PapercuspCommentCreate', variables: { input: { issueId: 'iss-1', body: 'Picked up by Papercusp.' } } }]);
    expect(hostFetchFor).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, providerId: KIND, sourceId, harness: HARNESS });

    // The comment comes back through the sync as the very document the update id names: the host's echo key.
    await due(sourceId);
    await syncOne(sourceId);
    const echo = (await docs(sourceId)).find((d) => d.external_id === posted.updateId);
    expect(echo).toMatchObject({ kind: 'ticket-comment', text: 'Picked up by Papercusp.' });
  });

  it('ticket.transition moves the issue to the column\'s first state; the move syncs back as one closed change on the same ticket', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const ticketId = dataSourceRecordId(WS, sourceId, 'ticket', 'iss-1');
    const recordSource = createRecordAdmissionSource({ registry, hostFetchFor: () => recordedHostFetch });
    lin.calls.length = 0;

    const moved = await recordSource.transition!({ db: sql as never, admission: admission(sourceId, 'iss-1'), toCategory: 'done' } as never);
    expect(moved).toMatchObject({ transitioned: true, externalRef: 'iss-1' });
    // Only the target state travels: the issue's title, description and assignee stay Linear's (D-004).
    expect(lin.calls).toEqual([
      { op: 'PapercuspIssueStates', variables: { id: 'iss-1' } },
      { op: 'PapercuspIssueTransition', variables: { id: 'iss-1', input: { stateId: st(ENG_STATES, 'Done').id } } },
    ]);

    // Already in the column: Linear is read, not written.
    lin.calls.length = 0;
    const again = await recordSource.transition!({ db: sql as never, admission: admission(sourceId, 'iss-1'), toCategory: 'done' } as never);
    expect(again).toMatchObject({ transitioned: false });
    expect(lin.calls.map((c) => c.op)).toEqual(['PapercuspIssueStates']);

    await due(sourceId);
    await syncOne(sourceId);
    const ticket = (await tickets(sourceId)).find((r) => r.feature_id === ticketId)!;
    expect(ticket.payload).toMatchObject({ state: 'closed', statusCategory: 'done', statusName: 'Done' });
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    const closed = (await changes(sourceId)).filter((r) => r.payload.transition === 'closed');
    expect(closed.map((r) => [r.payload.ticketWorkItemId, r.payload.actor])).toEqual([[ticketId, 'Papercusp']]);

    // A column the vocabulary does not know is refused before Linear is called.
    lin.calls.length = 0;
    await expect(recordSource.transition!({ db: sql as never, admission: admission(sourceId, 'iss-1'), toCategory: 'shipped' } as never))
      .rejects.toThrow(/transition_category_invalid:shipped/);
    expect(lin.calls).toEqual([]);
  });
});

// ── Provider-neutrality drift detectors ─────────────────────────────────────

/**
 * The provider's name as code spells it: `linear` at a word start not running on into a lower-case
 * word (`linear`, `linear-sync`, `linearSink`), `Linear` at a word start or camel hump
 * (`LinearClient`, `makeLinearClient`), or `LINEAR`. Case-sensitive on purpose: the English word
 * inside `nonlinear` / `bilinear` is not the provider.
 */
const LINEAR_TOKEN = /(?<![A-Za-z0-9])linear(?![a-z])|Linear(?![a-z])|(?<![A-Z])LINEAR(?![A-Z])/;
const MODULE_SPECIFIER = /\b(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]|\bfrom\s+['"`]([^'"`]+)['"`]/g;

/** Lines of CODE (comments stripped) naming Linear. */
function linearLines(source: string, fileName: string): string[] {
  return stripCommentsOnly(source, fileName).split('\n').filter((line) => LINEAR_TOKEN.test(line)).map((line) => line.trim());
}

/** Module specifiers other than node built-ins and the package's own manifest. */
function foreignImports(source: string, fileName: string): string[] {
  const found: string[] = [];
  for (const match of stripCommentsOnly(source, fileName).matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || specifier.startsWith('node:') || specifier === './papercusp.json') continue;
    found.push(specifier);
  }
  return found;
}

/** Host modules on a Linear record's path: driver, datatype routing, write-back, OAuth connection. */
const HOST_PATH = [
  'packages/operator-core/lib/providers/connector-runtime.ts',
  'packages/operator-core/lib/data-sources/datatype-destination-sink.ts',
  'packages/operator-core/lib/work-admission/record-source.ts',
  'packages/operator-core/lib/integrations/connection-lifecycle.ts',
  'packages/plugin-sdk/src/provider.ts',
];

describe('Linear stays a package, not host code', () => {
  it('each detector fires on planted drift and stays quiet on a planted clean sample', () => {
    expect(linearLines("if (source.kind === 'linear') return linearSink;", 'p.ts')).toHaveLength(1);
    expect(linearLines('const client = new LinearClient({ apiKey });', 'p.ts')).toHaveLength(1);
    expect(linearLines('const client = makeLinearClient(token);', 'p.ts')).toHaveLength(1);
    expect(linearLines("const LINEAR_API = 'https://api.example.com';", 'p.ts')).toHaveLength(1);
    expect(linearLines('// a comma joins scopes for Linear\nconst sep = descriptor.scopeSeparator;', 'c.ts')).toEqual([]);
    expect(linearLines('const nonlinearBackoff = curve(); const bilinear = 1;', 'c.ts')).toEqual([]);
    expect(foreignImports("const { LinearClient } = require('@linear/sdk');", 'p.cjs')).toEqual(['@linear/sdk']);
    expect(foreignImports("const m = require('./papercusp.json');\nconst u = require('node:url');", 'c.cjs')).toEqual([]);
  });

  it('the host driver, datatype routing, write-back and connection modules name no Linear in code', () => {
    for (const path of HOST_PATH) {
      expect({ path, lines: linearLines(readFileSync(join(REPO_ROOT, path), 'utf8'), path) }).toEqual({ path, lines: [] });
    }
  });

  it('the package imports nothing but node built-ins and its own manifest (no @linear/sdk at runtime)', () => {
    expect(readdirSync(PACKAGE_DIR).sort()).toEqual(['index.cjs', 'papercusp.json']);
    expect(foreignImports(readFileSync(join(PACKAGE_DIR, 'index.cjs'), 'utf8'), 'index.cjs')).toEqual([]);
  });
});
