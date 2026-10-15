/**
 * R-5 — Asana as a ticket provider on the integration contract
 * (plan linear-asana-task-sync-2026-10-05, P-005; decisions D-002, D-004, D-008, D-011).
 *
 * The REAL bundled package (`libs/papercusp/plugins/asana`) is discovered by the real plugin
 * loader and registered by the host's `registerPluginProviders`, then driven by the ONE shared
 * connector driver (`runConnectorSync`) with its DEFAULT sinks against a recorded Asana REST API
 * served through the provider's only network path, `host.fetch`. The recorded store behaves like
 * Asana where the provider depends on it: a project's task list pages by opaque offset; the Events
 * API answers a token-less read with 412 + a fresh sync token, replays every event after a token,
 * and 412s a token it dropped; stories record completion, section moves and comments; a section
 * move does not bump `modified_at`. Every recorded object and response is typed against Asana's
 * OpenAPI document (libs/papercusp/plugins/asana/openapi/asana-openapi.d.ts).
 *
 * R-5 is the core claim: across real-driver passes — a backfill crawl, then Events-token
 * incrementals with a task retitled and completed, a task moved between sections, a comment, and a
 * task multi-homed into a second configured project in between — every Asana task is exactly ONE
 * ticket record, updated in place. Also: a change made during the crawl is replayed by the first
 * incremental pass; a 412 re-backfills with new tokens and no duplicates; a rate limit keeps the
 * uncommitted cursor; an interrupted crawl resumes from the committed page; and both writes the
 * host dispatches by capability (`ticket.comment`, `ticket.transition`) reach Asana through
 * host.fetch and come back through the next sync as the same objects.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { HostFetch, HostFetchResponse } from '@papercusp/plugin-sdk';
import { loadPlugins } from '@papercusp/plugin-loader';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../../plugin-host-runtime';
import { createProviderRegistry, type ProviderRegistry, type RegisteredProvider } from '../../integrations/provider-registry';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../../external-triggers/ingestion';
import { upsertOwnedExternalTriggerSource } from '../../external-triggers/source-store';
import { fileTicketFromPlanRun } from '../../capability-verbs/ticket';
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
import type { components } from '../../../../../libs/papercusp/plugins/asana/openapi/asana-openapi';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspace: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql) };
});
// createWorkItem / mergeWorkItemPayload read in the operator's active workspace; pin it to the
// workspace the ticket datatype rows live in.
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = join(REPO_ROOT, 'libs/papercusp/plugins/asana');
const ROOT = join(tmpdir(), `papercusp-asana-it-${process.pid}-${Date.now()}`);

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const KIND = 'asana';
const API = 'https://app.asana.com/api/1.0';
const TICKET_DATATYPES = ['ticket', 'ticket-status-change', 'ticket-comment'];
const DESTINATIONS = { ticket: ['record'], 'ticket-status-change': ['event'], 'ticket-comment': ['document'] };

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let registry: ProviderRegistry;
let provider: RegisteredProvider;

// ── Recorded Asana, typed by Asana's OpenAPI document ───────────────────────

type Schemas = components['schemas'];
type Section = Schemas['SectionCompact'];
type Story = Schemas['StoryResponse'];
type AsanaEvent = Schemas['EventResponse'];
type Membership = { project?: Schemas['ProjectCompact']; section?: Section };
/**
 * A task as the recorded store holds it: Asana's own fields, mutable the way Asana mutates them.
 * `created_by` is widened to the user object Asana documents it as (its schema lists only gid and
 * resource_type; the unit test pins that gap).
 */
type Task = { -readonly [K in keyof Omit<Schemas['TaskResponse'], 'created_by' | 'memberships'>]: Schemas['TaskResponse'][K] }
  & { created_by?: Schemas['UserCompact']; memberships: Membership[] };

const ENG = { gid: 'proj-eng', resource_type: 'project', name: 'Engineering' } satisfies Schemas['ProjectCompact'];
const OPS = { gid: 'proj-ops', resource_type: 'project', name: 'Operations' } satisfies Schemas['ProjectCompact'];
const PROJECTS = { [ENG.gid]: ENG, [OPS.gid]: OPS };
const SECTIONS: Record<string, Section[]> = {
  [ENG.gid]: ['To do', 'Doing', 'Review', 'Done'].map((name) => ({ gid: `sec-eng-${name.toLowerCase().replace(' ', '')}`, resource_type: 'section', name })),
  [OPS.gid]: ['Inbox', 'Doing', 'Done'].map((name) => ({ gid: `sec-ops-${name.toLowerCase()}`, resource_type: 'section', name })),
};
const sec = (project: string, name: string): Section => SECTIONS[project]!.find((s) => s.name === name)!;
const projectOfSection = (gid: string) => Object.keys(SECTIONS).find((p) => SECTIONS[p]!.some((s) => s.gid === gid));

const PAPERCUSP_APP = { gid: 'u-app', resource_type: 'user', name: 'Papercusp' } satisfies Schemas['UserCompact'];
const BOB = { gid: 'u-bob', resource_type: 'user', name: 'Bob' } satisfies Schemas['UserCompact'];
const ALICE = { gid: 'u-alice', resource_type: 'user', name: 'Alice' } satisfies Schemas['UserCompact'];
/** The account the source is connected as: GET /users/me ("the Papercusp user", D-012). */
const PAPERCUSP = { gid: 'u-papercusp', resource_type: 'user', name: 'Papercusp' } satisfies Schemas['UserCompact'];
type User = Schemas['UserCompact'];

/** The source's config: both projects, and the columns its board sections stand for. */
const SOURCE_CONFIG = {
  workspaceGid: 'ws-1',
  projectGids: [ENG.gid, OPS.gid],
  sectionCategories: { Doing: 'in-progress', Review: 'in-review', Done: 'done' },
  harnessSlug: HARNESS,
};

interface Recorded {
  calls: Array<{ op: string; query: Record<string, string>; body?: unknown }>;
  tasks: Task[];
  stories: Map<string, Story[]>;
  /** Per project, every event in order; a sync token is a position in this log. */
  log: Record<string, AsanaEvent[]>;
  tokens: Map<string, { project: string; at: number }>;
  expired: Set<string>;
  rateLimitOnce: Set<string>;
  pageSize: number;
  nextStory: number;
  nextToken: number;
  minute: number;
  /** GET /users/me requests, kept out of `calls` so the op sequences below describe task traffic. */
  selfCalls: number;
  externalTasks: Map<string, Task>;
  createdTasks: number;
  loseCreateResponse: boolean;
}

let asana: Recorded;

function task(over: Partial<Task> & Pick<Task, 'gid' | 'name' | 'created_at' | 'modified_at' | 'memberships'>): Task {
  return {
    resource_type: 'task', notes: '', completed: false, permalink_url: `https://app.asana.com/0/${over.memberships[0]?.project?.gid}/${over.gid}`,
    created_by: ALICE, tags: [], ...over,
  };
}

function story(over: Partial<Story> & Pick<Story, 'gid' | 'resource_subtype' | 'created_at'>): Story {
  return { resource_type: 'story', created_by: BOB, ...over };
}

function recorded(): Recorded {
  return {
    calls: [],
    rateLimitOnce: new Set(),
    pageSize: 2,
    nextStory: 1,
    nextToken: 1,
    minute: 0,
    selfCalls: 0,
    externalTasks: new Map(),
    createdTasks: 0,
    loseCreateResponse: false,
    log: {},
    tokens: new Map(),
    expired: new Set(),
    tasks: [
      task({
        gid: 't-1', name: 'Cold start fails', notes: 'Steps attached.', due_on: '2026-10-09',
        created_at: '2026-10-01T08:00:00.000Z', modified_at: '2026-10-01T09:30:00.000Z',
        assignee: BOB, tags: [{ gid: 'tag-bug', resource_type: 'tag', name: 'bug' }],
        // Multi-homed: one task, two configured projects.
        memberships: [{ project: ENG, section: sec(ENG.gid, 'Doing') }, { project: OPS, section: sec(OPS.gid, 'Inbox') }],
      }),
      task({
        gid: 't-2', name: 'Flaky deploy check', created_at: '2026-10-01T08:10:00.000Z', modified_at: '2026-10-01T08:10:00.000Z',
        memberships: [{ project: ENG, section: sec(ENG.gid, 'To do') }],
      }),
      task({
        gid: 't-3', name: 'Runbook is stale', created_at: '2026-10-01T08:20:00.000Z', modified_at: '2026-10-01T08:20:00.000Z',
        parent: { gid: 't-1', resource_type: 'task', name: 'Cold start fails' },
        memberships: [{ project: ENG, section: sec(ENG.gid, 'To do') }],
      }),
      task({
        gid: 't-4', name: 'Rotate certificates', created_at: '2026-10-01T09:30:00.000Z', modified_at: '2026-10-01T10:30:00.000Z',
        memberships: [{ project: OPS, section: sec(OPS.gid, 'Doing') }],
      }),
    ],
    stories: new Map([
      ['t-1', [
        story({
          gid: 's-1', resource_subtype: 'section_changed', created_at: '2026-10-01T09:00:00.000Z',
          old_section: sec(ENG.gid, 'To do'), new_section: sec(ENG.gid, 'Doing'),
        }),
        story({ gid: 's-2', resource_subtype: 'comment_added', created_at: '2026-10-01T09:30:00.000Z', text: 'repro: the cache is cold after deploy' }),
      ]],
      ['t-4', [story({ gid: 's-4', resource_subtype: 'comment_added', created_at: '2026-10-01T10:30:00.000Z', text: 'on it', created_by: ALICE })]],
    ]),
  };
}

const taskById = (gid: string) => asana.tasks.find((t) => t.gid === gid);
const projectsOf = (t: Task) => t.memberships.map((m) => m.project?.gid).filter((p): p is string => Boolean(p));
function stamp(): string {
  asana.minute += 1;
  return new Date(Date.parse('2026-10-02T09:00:00.000Z') + asana.minute * 60_000).toISOString();
}

/** An event lands in the log of every project the task belongs to. */
function logEvent(t: Task, event: AsanaEvent): void {
  for (const project of projectsOf(t)) (asana.log[project] ??= []).push(event);
}
function taskChanged(t: Task, action = 'changed'): void {
  logEvent(t, { resource: { gid: t.gid, resource_type: 'task', name: t.name }, action, type: 'task', created_at: t.modified_at });
}
/** A story on a task. A comment or a completion bumps `modified_at`; a section move does not. */
function addStory(t: Task, over: Omit<Story, 'gid' | 'created_at'> & Pick<Story, 'resource_subtype'>, by: User, bumps: boolean): Story {
  const created = story({ ...over, gid: `s-new-${asana.nextStory++}`, created_at: stamp(), created_by: by });
  const list = asana.stories.get(t.gid!) ?? [];
  list.push(created);
  asana.stories.set(t.gid!, list);
  if (bumps) t.modified_at = created.created_at;
  logEvent(t, {
    resource: { gid: created.gid, resource_type: 'story' }, parent: { gid: t.gid, resource_type: 'task' }, action: 'added', type: 'story',
    created_at: created.created_at,
  });
  return created;
}
function setCompleted(t: Task, completed: boolean, by: User): void {
  if (t.completed === completed) return;
  const s = addStory(t, { resource_type: 'story', resource_subtype: completed ? 'marked_complete' : 'marked_incomplete' }, by, true);
  t.completed = completed;
  if (completed) t.completed_at = s.created_at;
  else delete t.completed_at;
  taskChanged(t);
}
function moveToSection(t: Task, target: Section, by: User): void {
  const membership = t.memberships.find((m) => m.project?.gid === projectOfSection(target.gid!));
  if (!membership || membership.section?.gid === target.gid) return;
  const old = membership.section;
  membership.section = target;
  addStory(t, { resource_type: 'story', resource_subtype: 'section_changed', old_section: old, new_section: target }, by, false);
}
function addToProject(t: Task, project: Schemas['ProjectCompact'], section: Section): void {
  t.memberships.push({ project, section });
  taskChanged(t, 'added');
}
/** Asana drops a project's sync tokens (it keeps events for a limited window). */
function expireTokens(project: string): void {
  for (const [token, at] of asana.tokens) if (at.project === project) asana.expired.add(token);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}
const notFound = () => json(404, { errors: [{ message: 'Not Found' }] } satisfies Schemas['ErrorResponse']);

function issueToken(project: string, at: number): string {
  const token = `sync-${project}-${asana.nextToken++}`;
  asana.tokens.set(token, { project, at });
  return token;
}

function events(query: Record<string, string>): HostFetchResponse {
  const project = query.resource!;
  const log = (asana.log[project] ??= []);
  const at = query.sync ? asana.tokens.get(query.sync) : undefined;
  if (!at || at.project !== project || asana.expired.has(query.sync!)) {
    return json(412, {
      errors: [{ message: 'Sync token invalid or too old. If you are attempting to keep resources in sync, you must fetch the full dataset for this query now and use the new sync token for the next sync.' }],
      sync: issueToken(project, log.length),
    } satisfies Schemas['GetEventsSyncExpired']);
  }
  const page = log.slice(at.at, at.at + 100);
  const end = at.at + page.length;
  return json(200, { data: page, sync: issueToken(project, end), has_more: end < log.length } satisfies Schemas['GetEventsOk']);
}

function crawl(project: string, offset: string | undefined): HostFetchResponse {
  const all = asana.tasks.filter((t) => projectsOf(t).includes(project));
  const start = offset === undefined ? 0 : Number(/^o(\d+)$/.exec(offset)?.[1] ?? NaN);
  if (!Number.isInteger(start)) return json(400, { errors: [{ message: 'offset: Your pagination token has expired.' }] } satisfies Schemas['ErrorResponse']);
  const page = all.slice(start, start + asana.pageSize);
  const next = start + page.length;
  const body: Schemas['GetTasksForProjectOk'] = {
    data: page as Schemas['TaskCompact'][],
    next_page: next < all.length ? { offset: `o${next}`, path: `/projects/${project}/tasks?offset=o${next}`, uri: `${API}/projects/${project}/tasks?offset=o${next}` } : null,
  };
  return json(200, body);
}

/** Recorded Asana REST, served through the provider's ONLY network path. */
const recordedHostFetch: HostFetch = async ({ request }) => {
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`.startsWith(`${API}/`)).toBe(true);
  expect(Object.keys(request.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  const method = request.method ?? 'GET';
  const path = decodeURIComponent(url.pathname.slice('/api/1.0'.length));
  const query = Object.fromEntries(url.searchParams);
  const body = request.body === undefined ? undefined : JSON.parse(request.body);
  const op = `${method} ${path}`;
  if (op === 'GET /users/me') {
    asana.selfCalls += 1;
    return json(200, { data: PAPERCUSP } satisfies Schemas['GetUserOk']);
  }
  asana.calls.push({ op, query, ...(body === undefined ? {} : { body }) });
  if (asana.rateLimitOnce.delete(op)) {
    return json(429, { errors: [{ message: 'You have made too many requests recently.' }] }, { 'Retry-After': '120' });
  }
  let m: RegExpExecArray | null;
  if (method === 'GET' && (m = /^\/tasks\/external:([^/]+)$/.exec(path))) {
    const t = asana.externalTasks.get(m[1]!);
    return t ? json(200, { data: t } satisfies Schemas['GetTaskOk']) : notFound();
  }
  if (method === 'POST' && path === '/tasks') {
    const { data } = body as { data: Schemas['TaskRequestBase'] & { projects: string[] } };
    expect(data.projects).toEqual([ENG.gid]);
    // ticket:file's correlation id, sha256(workspace:trigger run) (capability-verbs/ticket.ts).
    expect(data.external?.gid).toMatch(/^papercusp-ticket-[a-f0-9]{64}$/);
    const t = task({ gid: `t-slack-${++asana.createdTasks}`, name: data.name, notes: data.notes,
      created_at: '2026-10-02T09:01:00.000Z', modified_at: '2026-10-02T09:01:00.000Z',
      created_by: PAPERCUSP, memberships: [{ project: ENG, section: sec(ENG.gid, 'To do') }] });
    asana.tasks.push(t);
    asana.externalTasks.set(data.external!.gid!, t);
    asana.stories.set(t.gid!, []);
    taskChanged(t, 'added');
    if (asana.loseCreateResponse) {
      asana.loseCreateResponse = false;
      throw new Error('lost successful task response');
    }
    return json(201, { data: t } satisfies Schemas['GetTaskOk']);
  }
  // ticket.containers { purpose: 'create' } (ticket:file's destination check): workspaces, then projects.
  if (op === 'GET /workspaces') {
    return json(200, { data: [{ gid: SOURCE_CONFIG.workspaceGid, resource_type: 'workspace', name: 'Acme' }], next_page: null });
  }
  if (op === 'GET /projects') {
    expect(query.workspace).toBe(SOURCE_CONFIG.workspaceGid);
    return json(200, { data: Object.values(PROJECTS), next_page: null });
  }
  if (method === 'GET' && path === '/events') return events(query);
  if (method === 'GET' && (m = /^\/projects\/([^/]+)\/tasks$/.exec(path))) return crawl(m[1]!, query.offset);
  if (method === 'GET' && (m = /^\/projects\/([^/]+)\/sections$/.exec(path))) {
    return json(200, { data: SECTIONS[m[1]!] ?? [], next_page: null } satisfies Schemas['GetSectionsForProjectOk']);
  }
  if ((m = /^\/tasks\/([^/]+)\/stories$/.exec(path))) {
    const t = taskById(m[1]!);
    if (!t) return notFound();
    if (method === 'GET') return json(200, { data: asana.stories.get(t.gid!) ?? [], next_page: null } satisfies Schemas['GetStoriesForTaskOk']);
    const { data } = body as Schemas['CreateStoryForTaskBody'];
    const created = addStory(t, { resource_type: 'story', resource_subtype: 'comment_added', text: data?.text }, PAPERCUSP_APP, true);
    return json(201, { data: created } satisfies Schemas['CreateStoryForTaskCreated']);
  }
  if ((m = /^\/tasks\/([^/]+)$/.exec(path))) {
    const t = taskById(m[1]!);
    if (!t) return notFound();
    if (method === 'PUT') {
      const { data } = body as Schemas['UpdateTaskBody'];
      if (typeof data?.completed === 'boolean') setCompleted(t, data.completed, PAPERCUSP_APP);
    }
    return json(200, { data: t } satisfies Schemas['GetTaskOk']);
  }
  if (method === 'POST' && (m = /^\/sections\/([^/]+)\/addTask$/.exec(path))) {
    const { data } = body as Schemas['AddTaskForSectionBody'];
    const t = taskById(String(data?.task));
    const target = Object.values(SECTIONS).flat().find((s) => s.gid === m![1]);
    if (!t || !target) return notFound();
    moveToSection(t, target, PAPERCUSP_APP);
    return json(200, { data: {} });
  }
  return json(400, { errors: [{ message: `unrecorded request ${op}` }] });
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
  return { registry, ingest, hostFetchFor: () => recordedHostFetch, leaseOwner: 'asana-it', ...overrides };
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
      (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${KIND}, ${alice}, ${`asana-user-${Date.now()}`}, 'asana:fixture', 'connected',
            ${sql.json(SOURCE_CONFIG)}, 'personal',
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

/** R-5 as a query: externalIds that more than one ticket row claims (must be empty). */
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
  const target = join(projectDir, 'plugins', 'asana');
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
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`asana-provider-${Date.now()}`}, 'alice') RETURNING id`;
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
  asana = recorded();
  await clean();
});

const ops = () => asana.calls.map((c) => c.op);

// ── Registration ────────────────────────────────────────────────────────────

describe('Asana registers as a provider through the plugin host (P-005)', () => {
  it('discovers the complete package, preserving nested OpenAPI assets', () => {
    const installed = join(ROOT, 'project', 'plugins', 'asana');
    for (const file of ['asana-openapi.d.ts', 'asana-openapi.subset.json']) {
      expect(readFileSync(join(installed, 'openapi', file), 'utf8'))
        .toEqual(readFileSync(join(PACKAGE_DIR, 'openapi', file), 'utf8'));
    }
  });

  it('is a bundled package with the ticket datatypes, read + comment + transition, and an Asana OAuth install', () => {
    // Production discovers bundled plugins at <repo>/libs/papercusp/plugins (findBundledPluginsParent).
    expect(existsSync(join(PACKAGE_DIR, 'papercusp.json'))).toBe(true);
    expect(provider.pluginName).toBe(KIND);
    expect(provider.runtime).toBe('js');
    expect(provider.descriptor.datatypes).toEqual(TICKET_DATATYPES);
    expect(provider.descriptor.capabilities).toEqual([
      'ticket.read', 'ticket.create', 'ticket.comment', 'ticket.transition', 'ticket.containers', 'push.subscribe', 'push.unsubscribe',
    ]);
    expect(provider.descriptor.egressHosts).toEqual(['app.asana.com']);
    const oauth = provider.descriptor.oauth!;
    expect(oauth).toMatchObject({ authorizeUrl: 'https://app.asana.com/-/oauth_authorize', tokenUrl: 'https://app.asana.com/-/oauth_token' });
    // Full permissions (scope=default): the sync's GET /events has no granular scope (WI-10008209).
    expect(oauth.scopes).toEqual(['default']);
    expect(oauth.identity).toMatchObject({ url: `${API}/users/me?opt_fields=name`, idField: 'data.gid', displayNameField: 'data.name' });
    // The host's capability dispatch finds Asana for both ticket writes.
    expect(registry.forDatatype('ticket', recordWriteBackCapability('ticket')).map((p) => p.descriptor.id)).toEqual([KIND]);
    expect(registry.forDatatype('ticket', recordTransitionCapability('ticket')).map((p) => p.descriptor.id)).toEqual([KIND]);
    expect(registry.forDatatype('ticket', 'ticket.update')).toEqual([]);
  });

  it('serves ticket.read through host.fetch only', async () => {
    const sourceId = await createSource();
    const read = (await provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.read', args: { externalId: 't-1' }, config: SOURCE_CONFIG },
      { fetch: recordedHostFetch },
    )) as { ticket: Record<string, unknown> };
    expect(read.ticket).toMatchObject({ externalId: 't-1', container: 'Engineering', statusCategory: 'in-progress', statusName: 'Doing' });
    expect(ops()).toEqual(['GET /tasks/t-1']);
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.read', args: { externalId: 't-missing' }, config: SOURCE_CONFIG },
      { fetch: recordedHostFetch },
    )).rejects.toThrow('ticket_not_found:t-missing');
  });
});

// ── Sync through the shared driver ──────────────────────────────────────────

describe('Asana syncs through the shared connector driver (R-5)', () => {
  it('backfills tickets, status changes and comments for every configured project, routed by datatype', async () => {
    const sourceId = await createSource();
    const outcome = await syncOne(sourceId);
    // Engineering (two pages of two), then Operations (one page).
    expect(outcome).toMatchObject({ providerId: KIND, outcome: 'synced', mode: 'backfill', pages: 3, hasMore: false, rejected: 0 });
    // 4 tickets + 4 `opened` + 1 section move + 2 comments; t-1 read again through Operations dedupes.
    expect(outcome.admitted).toBe(11);
    expect(outcome.deduped).toBeGreaterThanOrEqual(4);
    // Each project's Events token is taken BEFORE its first task page.
    expect(ops().slice(0, 2)).toEqual(['GET /events', 'GET /projects/proj-eng/tasks']);
    expect(asana.calls[0]!.query).toEqual({ resource: ENG.gid });
    const opsToken = asana.calls.findIndex((c) => c.op === 'GET /events' && c.query.resource === OPS.gid);
    expect(opsToken).toBeLessThan(ops().indexOf('GET /projects/proj-ops/tasks'));
    expect(opsToken).toBeGreaterThan(ops().lastIndexOf('GET /projects/proj-eng/tasks'));
    const done = await cursorOf(sourceId);
    expect(done).toMatchObject({ backfill: 'complete', status: 'connected' });
    expect(done.raw).toMatchObject({ phase: 'events', project: 0, offset: null, fresh: {} });
    expect(Object.keys(done.raw!.tokens as object).sort()).toEqual([ENG.gid, OPS.gid]);

    const stored = await tickets(sourceId);
    expect(stored.map((r) => [r.nature, r.agent_work, r.payload.externalId, r.payload.container])).toEqual([
      ['record', false, 't-1', 'Engineering'],
      ['record', false, 't-2', 'Engineering'],
      ['record', false, 't-3', 'Engineering'],
      ['record', false, 't-4', 'Operations'],
    ]);
    const t1 = stored[0]!;
    expect(t1.feature_id).toBe(dataSourceRecordId(WS, sourceId, 'ticket', 't-1'));
    expect(t1.payload).toMatchObject({
      provider: 'asana', title: 'Cold start fails', body: 'Steps attached.', state: 'open', statusCategory: 'in-progress',
      statusName: 'Doing', section: 'Doing', projects: ['Engineering', 'Operations'], assignees: ['Bob'], labels: ['bug'],
      dueAt: '2026-10-09T00:00:00.000Z', author: 'Alice', dataSourceId: sourceId,
    });
    expect(stored[2]!.payload).toMatchObject({ statusCategory: 'todo', statusName: 'To do', parentExternalId: 't-1' });

    const moves = await changes(sourceId);
    expect(moves.map((r) => [r.nature, r.agent_work, r.payload.externalId, r.payload.transition])).toEqual([
      ['event', false, 'opened:t-1', 'opened'],
      ['event', false, 'opened:t-2', 'opened'],
      ['event', false, 'opened:t-3', 'opened'],
      ['event', false, 'opened:t-4', 'opened'],
      ['event', false, 'story:s-1', 'moved'],
    ]);
    expect(moves[4]!.payload).toMatchObject({
      ticketExternalId: 't-1', ticketWorkItemId: t1.feature_id, toCategory: 'in-progress', fromStatusName: 'To do', toStatusName: 'Doing', actor: 'Bob',
    });
    // Comments are documents in the owner's personal corpus, linked to their ticket.
    const comments = await docs(sourceId);
    expect(comments.map((d) => [d.kind, d.scope, d.user_id, d.external_id, d.text])).toEqual([
      ['ticket-comment', 'personal', alice, 'story:s-2', 'repro: the cache is cold after deploy'],
      ['ticket-comment', 'personal', alice, 'story:s-4', 'on it'],
    ]);
    expect(comments[0]!.metadata).toMatchObject({ ticketExternalId: 't-1', ticketWorkItemId: t1.feature_id });
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

  it('R-5: one ticket per task across passes — a retitle + completion, a section move, a comment and a multi-homing all update in place', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const first = await tickets(sourceId);
    expect(first).toHaveLength(4);
    const idOf = (externalId: string) => first.find((r) => r.payload.externalId === externalId)!.feature_id;

    // Between passes, in Asana:
    const t2 = taskById('t-2')!;
    t2.name = 'Flaky deploy check (CI)';
    t2.modified_at = stamp();
    taskChanged(t2);
    setCompleted(t2, true, BOB); // -> s-new-1
    moveToSection(taskById('t-3')!, sec(ENG.gid, 'Review'), ALICE); // -> s-new-2, modified_at unchanged
    addStory(taskById('t-1')!, { resource_type: 'story', resource_subtype: 'comment_added', text: 'fixed on main' }, BOB, true); // -> s-new-3
    addToProject(taskById('t-4')!, ENG, sec(ENG.gid, 'Doing')); // now multi-homed; Engineering is configured first

    asana.calls.length = 0;
    await due(sourceId);
    const second = await syncOne(sourceId);
    expect(second).toMatchObject({ outcome: 'synced', mode: 'incremental', pages: 2, rejected: 0, hasMore: false });
    // Four changed tickets, a completion, a section move, a comment; re-read stories dedupe.
    expect(second.admitted).toBe(7);
    // Each project's events are read from its own committed token; each touched task re-read.
    expect(asana.calls.filter((c) => c.op === 'GET /events').map((c) => [c.query.resource, Boolean(c.query.sync)])).toEqual([
      [ENG.gid, true], [OPS.gid, true],
    ]);
    expect(ops().filter((op) => /^GET \/tasks\/t-\d$/.test(op))).toEqual([
      'GET /tasks/t-2', 'GET /tasks/t-3', 'GET /tasks/t-1', 'GET /tasks/t-4', 'GET /tasks/t-1', 'GET /tasks/t-4',
    ]);
    expect(ops().some((op) => op.endsWith('/tasks') && op.startsWith('GET /projects'))).toBe(false); // no re-crawl

    const after = await tickets(sourceId);
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    expect(after.map((r) => r.feature_id).sort()).toEqual(first.map((r) => r.feature_id).sort());
    const byId = (externalId: string) => after.find((r) => r.feature_id === idOf(externalId))!.payload;
    expect(byId('t-2')).toMatchObject({
      title: 'Flaky deploy check (CI)', state: 'closed', statusCategory: 'done', statusName: 'Completed', closedAt: taskById('t-2')!.completed_at,
    });
    // A section move does not bump modified_at; the content-versioned record still updates.
    expect(byId('t-3')).toMatchObject({ state: 'open', statusCategory: 'in-review', statusName: 'Review', updatedAt: '2026-10-01T08:20:00.000Z' });
    expect(byId('t-4')).toMatchObject({ container: 'Engineering', statusCategory: 'in-progress', projects: ['Operations', 'Engineering'] });

    const newChanges = (await changes(sourceId)).filter((r) => ['story:s-new-1', 'story:s-new-2'].includes(String(r.payload.externalId)));
    expect(newChanges.map((r) => [r.payload.externalId, r.payload.transition, r.payload.toCategory, r.payload.ticketWorkItemId])).toEqual([
      ['story:s-new-1', 'closed', 'done', idOf('t-2')],
      ['story:s-new-2', 'moved', 'in-review', idOf('t-3')],
    ]);
    expect(await changes(sourceId)).toHaveLength(7);
    expect((await docs(sourceId)).map((d) => d.external_id)).toEqual(['story:s-2', 'story:s-4', 'story:s-new-3']);

    // Replay: nothing changed in Asana; each token advances, nothing is admitted.
    await due(sourceId);
    const replay = await syncOne(sourceId);
    expect(replay).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 0, rejected: 0, pages: 2 });
    expect(await tickets(sourceId)).toHaveLength(4);
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    expect(await changes(sourceId)).toHaveLength(7);
    expect(await docs(sourceId)).toHaveLength(3);
  });

  it('a dropped sync token (412) re-backfills the source with new tokens and no duplicate tickets', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const before = await cursorOf(sourceId);
    const oldTokens = before.raw!.tokens as Record<string, string>;
    expireTokens(ENG.gid);
    const t2 = taskById('t-2')!;
    t2.name = 'Flaky deploy check (CI)';
    t2.modified_at = stamp();
    taskChanged(t2);

    asana.calls.length = 0;
    await due(sourceId);
    const reset = await syncOne(sourceId);
    expect(reset).toMatchObject({ outcome: 'synced', mode: 'backfill', cursorReset: true, pages: 3, hasMore: false, rejected: 0 });
    expect(reset.admitted).toBe(1); // only the retitled ticket is a new version
    // The 412 came from Engineering's dropped token; the re-crawl then took a fresh token per project.
    expect(asana.calls[0]).toMatchObject({ op: 'GET /events', query: { resource: ENG.gid, sync: oldTokens[ENG.gid] } });
    const after = await cursorOf(sourceId);
    expect(after).toMatchObject({ backfill: 'complete' });
    const newTokens = after.raw!.tokens as Record<string, string>;
    expect(newTokens[ENG.gid]).not.toBe(oldTokens[ENG.gid]);
    expect(newTokens[OPS.gid]).not.toBe(oldTokens[OPS.gid]);
    expect(await tickets(sourceId)).toHaveLength(4);
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    expect((await tickets(sourceId)).find((r) => r.payload.externalId === 't-2')!.payload).toMatchObject({ title: 'Flaky deploy check (CI)' });

    // The new tokens work: the next pass is incremental again.
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 0 });
  });

  it('a rate limit keeps the uncommitted cursor; an interrupted crawl resumes, and a change made mid-crawl is replayed', async () => {
    const sourceId = await createSource();
    // Interrupted: one page allowed, so only Engineering's first page is admitted and committed.
    const first = await syncOne(sourceId, { maxPagesPerSource: 1 });
    expect(first).toMatchObject({ outcome: 'synced', pages: 1, hasMore: true });
    const committed = (await cursorOf(sourceId)).raw!;
    expect(committed).toMatchObject({ project: 0, phase: 'crawl', offset: 'o2', tokens: {} });
    expect(Object.keys(committed.fresh as object)).toEqual([ENG.gid]);
    expect((await tickets(sourceId)).map((r) => r.payload.externalId)).toEqual(['t-1', 't-2']);

    // Mid-crawl, in Asana: a comment on t-2, a task already crawled (and only in Engineering).
    addStory(taskById('t-2')!, { resource_type: 'story', resource_subtype: 'comment_added', text: 'seen again at 09:02' }, BOB, true);

    // The next page read is rate limited (Asana: HTTP 429 + Retry-After seconds).
    asana.rateLimitOnce.add('GET /projects/proj-eng/tasks');
    asana.calls.length = 0;
    const limited = await syncOne(sourceId);
    expect(limited).toMatchObject({ outcome: 'rate-limited', pages: 0 });
    const afterLimit = await cursorOf(sourceId);
    expect(afterLimit.raw).toEqual(committed);
    expect(afterLimit.nextIn).toBeGreaterThan(100);
    expect(afterLimit.nextIn).toBeLessThanOrEqual(121);
    expect(asana.calls.map((c) => [c.op, c.query.offset])).toEqual([['GET /projects/proj-eng/tasks', 'o2']]);

    // Resume: the crawl continues from Engineering's second page; the committed first page is never
    // re-read and Engineering's token is not re-taken.
    await due(sourceId);
    asana.calls.length = 0;
    const resumed = await syncOne(sourceId);
    expect(resumed).toMatchObject({ outcome: 'synced', mode: 'backfill', pages: 2, hasMore: false });
    expect(asana.calls.filter((c) => c.op === 'GET /projects/proj-eng/tasks').map((c) => c.query.offset)).toEqual(['o2']);
    expect(asana.calls.filter((c) => c.op === 'GET /events').map((c) => c.query.resource)).toEqual([OPS.gid]);
    expect(await cursorOf(sourceId)).toMatchObject({ backfill: 'complete' });
    expect(await tickets(sourceId)).toHaveLength(4);
    expect((await docs(sourceId)).map((d) => d.external_id)).toEqual(['story:s-2', 'story:s-4']);

    // The first incremental pass replays what changed after Engineering's token was taken.
    await due(sourceId);
    const replayed = await syncOne(sourceId);
    expect(replayed).toMatchObject({ outcome: 'synced', mode: 'incremental' });
    expect((await docs(sourceId)).map((d) => [d.external_id, d.text])).toEqual([
      ['story:s-2', 'repro: the cache is cold after deploy'],
      ['story:s-4', 'on it'],
      ['story:s-new-1', 'seen again at 09:02'],
    ]);
    expect(await duplicatedTickets(sourceId)).toEqual([]);
  });
});

// ── Writes dispatched by the host ───────────────────────────────────────────

describe('admission presets turn matching Asana tasks into work (P-006, R-6)', () => {
  /** Another Asana user whose name is ALSO "Papercusp": only the gid says who is who. */
  const LOOKALIKE = { gid: 'u-lookalike', resource_type: 'user', name: 'Papercusp' } satisfies Schemas['UserCompact'];

  type Admitted = { record: string; via: string; rule_id: string | null; kind: string; agent_work: boolean; about: number };
  async function admitted(sourceId: string): Promise<Admitted[]> {
    return sql<Admitted[]>`
      SELECT a.source_key AS record, a.admitted_via AS via, a.rule_id::text AS rule_id, w.item_kind AS kind,
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
  const recordOf = (sourceId: string, gid: string) => dataSourceRecordId(WS, sourceId, 'ticket', gid);
  const preset = (sourceId: string, p: TicketRulePreset, value?: string) =>
    setAdmissionRuleAndBackfill(
      { workspaceId: WS, dataSourceId: sourceId, title: `${p} ${value ?? ''}`.trim(), match: ticketRulePreset(p, value), harness: HARNESS, createdBy: 'asana-it' },
      { sql },
    );
  const setTask = (gid: string, over: Partial<Task>) => {
    const i = asana.tasks.findIndex((t) => t.gid === gid);
    asana.tasks[i] = { ...asana.tasks[i]!, ...over };
  };

  it('assigned-to-papercusp: the task assigned to the connected user becomes exactly one linked work item', async () => {
    setTask('t-2', { assignee: PAPERCUSP });
    setTask('t-4', { assignee: LOOKALIKE }); // same name, different user: not Papercusp's
    const sourceId = await createSource();
    const { rule } = await preset(sourceId, 'assigned-to-papercusp');

    await syncOne(sourceId);
    const rows1 = await admitted(sourceId);
    expect(rows1).toEqual([
      { record: recordOf(sourceId, 't-2'), via: 'rule', rule_id: rule.id, kind: 'change', agent_work: true, about: 1 },
    ]);
    expect((await tickets(sourceId)).map((t) => [t.payload.externalId, t.agent_work, t.payload.selfRoles ?? null])).toEqual([
      ['t-1', false, null], ['t-2', false, ['assignee']], ['t-3', false, null], ['t-4', false, null],
    ]);
    // The connected user is looked up once for the whole backfill, then carried in the cursor.
    expect(asana.selfCalls).toBe(1);

    await due(sourceId);
    await syncOne(sourceId);
    expect(await admitted(sourceId)).toEqual(rows1);
  });

  it('a project rule added after the sync admits each held task in it once, a multi-homed task included', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    expect(await admitted(sourceId)).toEqual([]); // no rule, no work

    const { rule, backfill } = await preset(sourceId, 'project', 'operations');
    expect(backfill).toMatchObject({ scanned: 4, admitted: 2, existing: 0, refused: [], truncated: false });
    const expected: Admitted[] = [
      // t-1 lives in Engineering AND Operations: one ticket, so one work item; its "bug" tag makes it a bug.
      { record: recordOf(sourceId, 't-1'), via: 'rule', rule_id: rule.id, kind: 'bug', agent_work: true, about: 1 },
      { record: recordOf(sourceId, 't-4'), via: 'rule', rule_id: rule.id, kind: 'change', agent_work: true, about: 1 },
    ];
    expect(await admitted(sourceId)).toEqual(expected.sort((a, b) => (a.record < b.record ? -1 : 1)));
  });

  it('a tag arrives as a label: the label preset admits the tagged task only', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    expect((await preset(sourceId, 'label', 'needs-design')).backfill).toMatchObject({ scanned: 4, admitted: 0 });
    expect((await preset(sourceId, 'label', 'bug')).backfill).toMatchObject({ admitted: 1 });
    expect((await admitted(sourceId)).map((a) => [a.record, a.kind])).toEqual([[recordOf(sourceId, 't-1'), 'bug']]);
  });

  it('admits a direct new Asana bug after activation once while history and later historical edits remain data', async () => {
    const sourceId = await createSource();
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'backfill', rejected: 0 });
    const { rule, backfill } = await setAdmissionRuleAndBackfill({
      workspaceId: WS, dataSourceId: sourceId, title: 'New Engineering bug reports',
      match: { provider: { eq: 'asana' }, projects: { contains: 'Engineering' }, state: { eq: 'open' },
        createdAt: { after: '2026-10-02T09:00:00.000Z' } },
      harness: HARNESS, workKind: 'bug', createdBy: 'asana-new-task-test',
    }, { sql });
    expect(backfill).toMatchObject({ scanned: 4, admitted: 0, refused: [] });
    const fresh = task({ gid: 't-direct-new', name: 'Exported invoice drops the last line item',
      notes: 'Create an invoice with two items, export PDF: the second item is absent. Both items must appear.',
      created_at: '2026-10-02T09:01:00.000Z', modified_at: '2026-10-02T09:01:00.000Z',
      memberships: [{ project: ENG, section: sec(ENG.gid, 'To do') }] });
    asana.tasks.push(fresh); asana.stories.set(fresh.gid!, []); taskChanged(fresh, 'added');
    const old = taskById('t-1')!;
    old.modified_at = '2026-10-02T09:02:00.000Z'; taskChanged(old);
    // A new completed task is outside this rule even though it passes the time boundary.
    const closed = task({ ...fresh, gid: 't-new-closed', name: 'Already resolved issue', completed: true });
    asana.tasks.push(closed); asana.stories.set(closed.gid!, []); taskChanged(closed, 'added');
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'incremental', rejected: 0 });
    const expected = [{ record: recordOf(sourceId, fresh.gid!), via: 'rule', rule_id: rule.id,
      kind: 'bug', agent_work: true, about: 1 }];
    expect(await admitted(sourceId)).toEqual(expected);
    const persisted = await tickets(sourceId);
    expect(persisted.find((r) => r.payload.externalId === fresh.gid)?.payload).toMatchObject({
      provider: 'asana', createdAt: fresh.created_at, title: fresh.name,
    });
    const [work] = await sql<Array<{ admission: string; payload: Record<string, unknown> }>>`
      SELECT w.admission, w.payload FROM harness_shared.work_items w
      JOIN harness_shared.work_admissions a ON a.workspace_id = w.workspace_id AND a.work_item_id = w.feature_id
      WHERE a.workspace_id = ${WS} AND a.source_key = ${recordOf(sourceId, fresh.gid!)}`;
    expect(work).toBeDefined();
    expect(work.admission).toBe('pending');
    expect(work.payload).not.toHaveProperty('implementationAcceptance');
    const admissionIdentity = () => sql<Array<{ admission_id: string; work_item_id: string }>>`
      SELECT a.id::text AS admission_id, a.work_item_id FROM harness_shared.work_admissions a
      WHERE a.workspace_id = ${WS} AND a.data_source_id = ${sourceId}::uuid
        AND a.source_key = ${recordOf(sourceId, fresh.gid!)}`;
    const originalIdentity = await admissionIdentity();
    expect(originalIdentity).toEqual([{ admission_id: expect.any(String), work_item_id: expect.any(String) }]);
    // Replay the provider event, then reconnect from a fresh crawl: the
    // sync must succeed as well as retain the original admission and work item.
    // A failed duplicate INSERT can leave the old row intact, so row presence
    // alone does not prove that replay or reconnect worked.
    taskChanged(fresh, 'added');
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'incremental', rejected: 0 });
    expect(await admitted(sourceId)).toEqual(expected);
    expect(await admissionIdentity()).toEqual(originalIdentity);

    // An identical provider revision is deduped before admission. A real edit
    // must reach admission again and retain the same work item; failed sink
    // delivery must not masquerade as success just because the old row survives.
    const admissionDeliveries = () => sql<Array<{ dedupe_key: string; outcome: string }>>`
      SELECT dedupe_key, outcome FROM harness_shared.trigger_deliveries
      WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid
        AND sink_kind = 'data-source-admission' AND datatype_id = 'ticket'
        AND dedupe_key LIKE ${`connector:${sourceId}:ticket:${fresh.gid!}:%`}
      ORDER BY dedupe_key`;
    const firstDeliveries = await admissionDeliveries();
    expect(firstDeliveries).toEqual([{ dedupe_key: expect.any(String), outcome: 'delivered' }]);
    fresh.name = 'Exported invoice drops the final line item after editing';
    fresh.modified_at = '2026-10-02T09:03:00.000Z';
    taskChanged(fresh);
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'incremental', rejected: 0 });
    expect((await tickets(sourceId)).find((r) => r.payload.externalId === fresh.gid)?.payload.title).toBe(fresh.name);
    expect(await admitted(sourceId)).toEqual(expected);
    expect(await admissionIdentity()).toEqual(originalIdentity);
    const editedDeliveries = await admissionDeliveries();
    expect(editedDeliveries).toHaveLength(2);
    expect(new Set(editedDeliveries.map((d) => d.dedupe_key)).size).toBe(2);
    for (const delivery of editedDeliveries) expect(delivery.outcome).toBe('delivered');
    taskChanged(fresh);
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'incremental', rejected: 0 });
    expect(await admissionDeliveries()).toEqual(editedDeliveries);
    expect(await admissionIdentity()).toEqual(originalIdentity);
    await sql`UPDATE harness_shared.data_sources SET cursor = '{}'::jsonb, status = 'connected'
      WHERE id = ${sourceId}::uuid AND workspace_id = ${WS}`;
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', rejected: 0 });
    expect(await admitted(sourceId)).toEqual(expected);
    expect(await admissionIdentity()).toEqual(originalIdentity);
    expect(await admissionDeliveries()).toEqual(editedDeliveries);
  });

  // Chat-originated filing by itself (destination choice, negative verdicts,
  // lost-response recovery, replays file nothing) is the bug-triage pack's
  // ticket:file path, covered in capability-verbs/ticket.integration.test.ts
  // (cupboard-distributable-integrations-2026-10-10#D-019). The test below is
  // the cross-stage join (slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08#P-005):
  // the task ticket:file creates from a Slack message comes back through this
  // source's sync and enters work exactly like a task a person created in
  // Asana, through the same rule, once.
  it('admits a Slack-filed ticket and a manually created one through one rule, each exactly once, across a lost create response and replays', async () => {
    const sourceId = await createSource();
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'backfill', rejected: 0 });
    const { rule, backfill } = await setAdmissionRuleAndBackfill({
      workspaceId: WS, dataSourceId: sourceId, title: 'New Engineering bug reports',
      match: { provider: { eq: 'asana' }, projects: { contains: 'Engineering' }, state: { eq: 'open' },
        createdAt: { after: '2026-10-02T09:00:00.000Z' } },
      harness: HARNESS, workKind: 'bug', createdBy: 'asana-echo-test',
    }, { sql });
    expect(backfill).toMatchObject({ admitted: 0, refused: [] });

    // The chat side: a Slack source, a bug-triage installation whose destination is
    // Engineering, and the succeeded trigger run that launched plan run `run` for one message.
    const chat = await upsertOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'slack', ownerUserId: alice,
      credentialRef: 'slack:declared', status: 'connected', config: {} });
    const planSlug = `bug-triage-echo-${Date.now()}`;
    const run = 910_001;
    const manifest = {
      name: 'bug-triage', version: '0.1.0',
      triggerPack: { inputs: { type: 'object', properties: {
        destination: { type: 'string', 'x-options': { capability: 'ticket.containers', args: { purpose: 'create' } } },
      } } },
    };
    let bindingId: string | null = null;
    let installationId: string | null = null;
    try {
      await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
        VALUES (${WS}, ${HARNESS}, ${planSlug}) ON CONFLICT DO NOTHING`;
      const [installation] = await sql<Array<{ id: string }>>`INSERT INTO harness_shared.trigger_pack_installations
        (workspace_id, harness_slug, plugin_name, plugin_version, inputs, manifest, status)
        VALUES (${WS}, ${HARNESS}, ${planSlug}, '0.1.0', ${JSON.stringify({ destination: ENG.gid })}::text::jsonb,
          ${JSON.stringify(manifest)}::text::jsonb, 'configured') RETURNING id::text`;
      installationId = installation!.id;
      const [binding] = await sql<Array<{ id: string }>>`INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern, armed, pack_installation_id)
        VALUES (${WS}, ${chat.id}::uuid, ${HARNESS}, ${planSlug}, 'ext:slack:message', TRUE, ${installationId}::uuid)
        RETURNING id::text`;
      bindingId = binding!.id;
      const message = { id: 'C1:17770000.1', channelId: 'C1', threadId: '17770000.1', sender: 'U1',
        text: 'Exporting a report crashes the app every time.' };
      await sql`INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, dedupe_key, status, args, plan_run_ref, completed_at)
        VALUES (${WS}, ${bindingId}::uuid, ${'echo-' + planSlug}, 'succeeded',
          ${JSON.stringify({ trigger: { key: 'chat-message.message', payload: message } })}::text::jsonb, ${String(run)}, now())`;
      const fileDeps = { registry, hostFetchFor: () => recordedHostFetch, options: { hostFetchFor: () => recordedHostFetch } };
      const fileFromChat = () => fileTicketFromPlanRun(sql, { workspaceId: WS, planRunId: run,
        title: 'Report export crashes', observed: 'Exporting a report crashes the app.', expected: 'The export completes.' }, fileDeps);
      const creates = () => asana.calls.filter((c) => c.op === 'POST /tasks').length;

      // The create lands in Asana but its response is lost: pending, then recovered without a second POST.
      asana.loseCreateResponse = true;
      expect(await fileFromChat()).toMatchObject({ pendingReconciliation: true });
      expect(await fileFromChat()).toMatchObject({ alreadyCreated: true, externalRef: 't-slack-1', sourceId });
      expect(creates()).toBe(1);

      // A person files the second ticket straight in Asana.
      const manual = task({ gid: 't-manual-new', name: 'Exported invoice drops the last line item',
        notes: 'Create an invoice with two items, export PDF: the second item is absent. Both items must appear.',
        created_at: '2026-10-02T09:02:00.000Z', modified_at: '2026-10-02T09:02:00.000Z', created_by: BOB,
        memberships: [{ project: ENG, section: sec(ENG.gid, 'To do') }] });
      asana.tasks.push(manual); asana.stories.set(manual.gid!, []); taskChanged(manual, 'added');

      await due(sourceId);
      expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', mode: 'incremental', rejected: 0 });
      const byRecord = (rows: Admitted[]) => [...rows].sort((a, b) => a.record.localeCompare(b.record));
      const expected = byRecord(['t-slack-1', manual.gid!].map((gid) => ({ record: recordOf(sourceId, gid), via: 'rule',
        rule_id: rule.id, kind: 'bug', agent_work: true, about: 1 })));
      expect(byRecord(await admitted(sourceId))).toEqual(expected);
      expect((await tickets(sourceId)).find((r) => r.payload.externalId === 't-slack-1')?.payload)
        .toMatchObject({ provider: 'asana', title: 'Report export crashes' });

      // Replaying the filing and syncing again neither files nor admits a second time.
      expect(await fileFromChat()).toMatchObject({ alreadyCreated: true, externalRef: 't-slack-1' });
      await due(sourceId);
      expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', rejected: 0 });
      expect(creates()).toBe(1);
      expect(byRecord(await admitted(sourceId))).toEqual(expected);
    } finally {
      if (bindingId) {
        await sql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS} AND binding_id = ${bindingId}::uuid`;
        await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND id = ${bindingId}::uuid`;
      }
      if (installationId) {
        await sql`DELETE FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS} AND id = ${installationId}::uuid`;
      }
      await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${chat.id}::uuid`;
      await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;
    }
  });
});

describe('the host writes back to Asana by capability (D-008)', () => {
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
    asana.calls.length = 0;
    const posted = await recordSource.writeBack!({ db: sql as never, admission: admission(sourceId, 't-1'), text: '  Picked up by Papercusp.  ' } as never);
    expect(posted).toMatchObject({ posted: true, updateId: 'story:s-new-1' });
    const body: Schemas['CreateStoryForTaskBody'] = { data: { text: 'Picked up by Papercusp.' } };
    expect(asana.calls).toEqual([{ op: 'POST /tasks/t-1/stories', query: {}, body }]);
    expect(hostFetchFor).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, providerId: KIND, sourceId, harness: HARNESS });
    // The comment comes back through the sync as the very document the update id names: the host's echo key.
    await due(sourceId);
    await syncOne(sourceId);
    const echo = (await docs(sourceId)).find((d) => d.external_id === posted.updateId);
    expect(echo).toMatchObject({ kind: 'ticket-comment', text: 'Picked up by Papercusp.' });
    expect(echo!.metadata).toMatchObject({ ticketExternalId: 't-1' });
  });

  it('ticket.transition completes the task and files it in the Done section; the close syncs back on the same ticket', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const ticketId = dataSourceRecordId(WS, sourceId, 'ticket', 't-1');
    const recordSource = createRecordAdmissionSource({ registry, hostFetchFor: () => recordedHostFetch });
    asana.calls.length = 0;
    const moved = await recordSource.transition!({ db: sql as never, admission: admission(sourceId, 't-1'), toCategory: 'done' } as never);
    expect(moved).toMatchObject({ transitioned: true, externalRef: 't-1' });
    // Only completion and the section travel: the task's name, notes and assignee stay Asana's (D-004).
    expect(ops()).toEqual(['GET /tasks/t-1', 'GET /projects/proj-eng/sections', 'PUT /tasks/t-1', `POST /sections/${sec(ENG.gid, 'Done').gid}/addTask`]);
    const complete: Schemas['UpdateTaskBody'] = { data: { completed: true } };
    const file: Schemas['AddTaskForSectionBody'] = { data: { task: 't-1' } };
    expect(asana.calls.filter((c) => c.body !== undefined).map((c) => c.body)).toEqual([complete, file]);
    // Already in the column: Asana is read, not written.
    asana.calls.length = 0;
    const again = await recordSource.transition!({ db: sql as never, admission: admission(sourceId, 't-1'), toCategory: 'done' } as never);
    expect(again).toMatchObject({ transitioned: false });
    expect(ops()).toEqual(['GET /tasks/t-1']);

    await due(sourceId);
    await syncOne(sourceId);
    const ticket = (await tickets(sourceId)).find((r) => r.feature_id === ticketId)!;
    expect(ticket.payload).toMatchObject({ state: 'closed', statusCategory: 'done', statusName: 'Completed', section: 'Done' });
    expect(await duplicatedTickets(sourceId)).toEqual([]);
    // Asana records two stories for that one write (marked complete, moved to Done); both are
    // Papercusp's, both on the same ticket. Lifecycle reads the ticket's state, not the events.
    const closed = (await changes(sourceId)).filter((r) => r.payload.transition === 'closed');
    expect(closed.map((r) => [r.payload.ticketWorkItemId, r.payload.actor])).toEqual([[ticketId, 'Papercusp'], [ticketId, 'Papercusp']]);

    // A column the vocabulary does not know is refused before Asana is called.
    asana.calls.length = 0;
    await expect(recordSource.transition!({ db: sql as never, admission: admission(sourceId, 't-1'), toCategory: 'shipped' } as never))
      .rejects.toThrow(/transition_category_invalid:shipped/);
    expect(asana.calls).toEqual([]);
  });

  it('ticket.transition to an open column moves the task between sections using the source\'s section mapping', async () => {
    const sourceId = await createSource();
    await syncOne(sourceId);
    const recordSource = createRecordAdmissionSource({ registry, hostFetchFor: () => recordedHostFetch });
    asana.calls.length = 0;
    const moved = await recordSource.transition!({ db: sql as never, admission: admission(sourceId, 't-2'), toCategory: 'in-review' } as never);
    expect(moved).toMatchObject({ transitioned: true, externalRef: 't-2' });
    // An open task moving between open columns: a section move only, no completion write.
    expect(ops()).toEqual(['GET /tasks/t-2', 'GET /projects/proj-eng/sections', `POST /sections/${sec(ENG.gid, 'Review').gid}/addTask`]);
    await due(sourceId);
    await syncOne(sourceId);
    const t2 = (await tickets(sourceId)).find((r) => r.payload.externalId === 't-2')!;
    expect(t2.payload).toMatchObject({ state: 'open', statusCategory: 'in-review', statusName: 'Review' });
  });
});

// ── Provider-neutrality drift detectors ─────────────────────────────────────

/**
 * The provider's name as code spells it: `asana` at a word start not running on into a lower-case
 * word (`asana`, `asana-sync`, `asanaSink`), `Asana` at a word start or camel hump (`AsanaClient`,
 * `makeAsanaClient`), or `ASANA`. Case-sensitive on purpose.
 */
const ASANA_TOKEN = /(?<![A-Za-z0-9])asana(?![a-z])|Asana(?![a-z])|(?<![A-Z])ASANA(?![A-Z])/;
const MODULE_SPECIFIER = /\b(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]|\bfrom\s+['"`]([^'"`]+)['"`]/g;

/** Lines of CODE (comments stripped) naming Asana. */
function asanaLines(source: string, fileName: string): string[] {
  return stripCommentsOnly(source, fileName).split('\n').filter((line) => ASANA_TOKEN.test(line)).map((line) => line.trim());
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

/** Host modules on an Asana record's path: driver, datatype routing, write-back, OAuth connection. */
const HOST_PATH = [
  'packages/operator-core/lib/providers/connector-runtime.ts',
  'packages/operator-core/lib/data-sources/datatype-destination-sink.ts',
  'packages/operator-core/lib/work-admission/record-source.ts',
  'packages/operator-core/lib/integrations/connection-lifecycle.ts',
  'packages/plugin-sdk/src/provider.ts',
];

describe('Asana stays a package, not host code', () => {
  it('each detector fires on planted drift and stays quiet on a planted clean sample', () => {
    expect(asanaLines("if (source.kind === 'asana') return asanaSink;", 'p.ts')).toHaveLength(1);
    expect(asanaLines('const client = new AsanaClient({ token });', 'p.ts')).toHaveLength(1);
    expect(asanaLines('const client = makeAsanaClient(token);', 'p.ts')).toHaveLength(1);
    expect(asanaLines("const ASANA_API = 'https://api.example.com';", 'p.ts')).toHaveLength(1);
    expect(asanaLines('// sections map to columns for Asana\nconst map = source.config.sectionCategories;', 'c.ts')).toEqual([]);
    expect(asanaLines('const yogaAsanas = poses(); const asanas = 1;', 'c.ts')).toEqual([]);
    expect(foreignImports("const asana = require('asana');", 'p.cjs')).toEqual(['asana']);
    expect(foreignImports("const m = require('./papercusp.json');\nconst u = require('node:url');", 'c.cjs')).toEqual([]);
  });

  it('the host driver, datatype routing, write-back and connection modules name no Asana in code', () => {
    for (const path of HOST_PATH) {
      expect({ path, lines: asanaLines(readFileSync(join(REPO_ROOT, path), 'utf8'), path) }).toEqual({ path, lines: [] });
    }
  });

  it('the package imports nothing but node built-ins and its own manifest (no Asana SDK at runtime)', () => {
    expect(readdirSync(PACKAGE_DIR).sort()).toEqual(['index.cjs', 'openapi', 'papercusp.json']);
    expect(foreignImports(readFileSync(join(PACKAGE_DIR, 'index.cjs'), 'utf8'), 'index.cjs')).toEqual([]);
  });
});
