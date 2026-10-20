/**
 * Linear provider package, unit level (linear-asana-task-sync-2026-10-05 P-004, R-4).
 *
 * Loads the real `libs/papercusp/plugins/linear` package and drives its adapter through a fake
 * `host.fetch` that answers Linear's GraphQL endpoint. Covers the issue -> ticket mapping, the
 * workflow-state -> column mapping, status changes from issue history, the cursor (pagination,
 * team order, watermark fold, config change), rate-limit and auth signals, and the writes
 * (ticket.comment, ticket.transition). The real-driver/Postgres proof is
 * linear-provider.integration.test.ts.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse } from '@papercusp/plugin-sdk';
import { TICKET_STATUS_CATEGORIES, ticketTransitionBetween } from '../../data-sources/ticket-vocabulary';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin = requireCjs(resolve(REPO_ROOT, 'libs/papercusp/plugins/linear/index.cjs')) as any;
const adapter = plugin.providerAdapter;
const internal = plugin._internal;

/** The host passes the data source id; host.fetch resolves its token from it. */
const SOURCE = 'src-1';

type Gql = { query: string; variables: Record<string, unknown> };
type Handler = (op: string, variables: Record<string, unknown>) => HostFetchResponse;

function json(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

function fakeHost(handler: Handler) {
  const calls: Array<{ op: string; variables: Record<string, unknown>; request: HostFetchRequest }> = [];
  const fetch: HostFetch = async ({ request }) => {
    expect(request.url).toBe('https://api.linear.app/graphql');
    expect(request.method).toBe('POST');
    const parsed = JSON.parse(String(request.body)) as Gql;
    const op = /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? '?';
    calls.push({ op, variables: parsed.variables, request });
    return handler(op, parsed.variables);
  };
  return { fetch, calls, host: { fetch } };
}

const STATES = {
  triage: { id: 'st-triage', name: 'Triage', type: 'triage', position: 0 },
  backlog: { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 1 },
  todo: { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 2 },
  ready: { id: 'st-ready', name: 'Ready', type: 'unstarted', position: 3 },
  doing: { id: 'st-doing', name: 'In Progress', type: 'started', position: 5 },
  review: { id: 'st-review', name: 'In Review', type: 'started', position: 4 },
  done: { id: 'st-done', name: 'Done', type: 'completed', position: 6 },
  canceled: { id: 'st-canceled', name: 'Canceled', type: 'canceled', position: 7 },
};

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 'iss-1', identifier: 'ENG-1', number: 1, title: 'Cold start fails', description: 'Steps attached.',
    url: 'https://linear.app/acme/issue/ENG-1', priority: 2, priorityLabel: 'High', estimate: 3, dueDate: '2026-10-09',
    createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z', completedAt: null, canceledAt: null,
    state: STATES.doing, team: { id: 'team-a', key: 'ENG' },
    assignee: { id: 'u-bob', name: 'bob', displayName: 'Bob' }, delegate: { id: 'u-app', name: 'papercusp', displayName: 'Papercusp' },
    creator: { id: 'u-alice', name: 'alice', displayName: 'Alice' }, parent: { id: 'iss-0' }, project: { id: 'p-1', name: 'Reliability' },
    labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] },
    history: { nodes: [] as unknown[] },
    ...over,
  };
}

function page(field: string, nodes: unknown[], endCursor: string | null = null) {
  return json(200, { data: { [field]: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } });
}

describe('Linear workflow states map onto the canonical columns', () => {
  it('maps every state type, a started "review" state to in-review, and agrees with the host vocabulary', () => {
    expect(internal.categoryOf(STATES.triage)).toBe('triage');
    expect(internal.categoryOf(STATES.backlog)).toBe('backlog');
    expect(internal.categoryOf(STATES.todo)).toBe('todo');
    expect(internal.categoryOf(STATES.doing)).toBe('in-progress');
    expect(internal.categoryOf(STATES.review)).toBe('in-review');
    expect(internal.categoryOf(STATES.done)).toBe('done');
    expect(internal.categoryOf(STATES.canceled)).toBe('canceled');
    expect(internal.categoryOf({ id: 'x', name: 'Dup', type: 'duplicate' })).toBe('canceled');
    expect(internal.categoryOf({ id: 'x', name: '?', type: 'nonsense' })).toBeNull();
    // The plugin restates the host's transition rule; pin it to the TypeScript source of truth.
    for (const from of [null, ...TICKET_STATUS_CATEGORIES]) {
      for (const to of TICKET_STATUS_CATEGORIES) {
        expect(internal.transitionBetween(from, to)).toBe(ticketTransitionBetween(from, to));
      }
    }
  });
});

describe('a Linear issue becomes one canonical ticket', () => {
  it('maps identity, column, people, priority, dates and relations', () => {
    expect(internal.issueToTicket(issue())).toEqual({
      provider: 'linear', externalId: 'iss-1', container: 'ENG', number: 1, identifier: 'ENG-1',
      title: 'Cold start fails', body: 'Steps attached.', state: 'open', statusCategory: 'in-progress', statusName: 'In Progress',
      assignees: ['Bob'], delegates: ['Papercusp'], labels: ['bug', 'p1'], priority: { level: 2, name: 'High' }, estimate: 3,
      dueAt: '2026-10-09T00:00:00.000Z', parentExternalId: 'iss-0', projects: ['Reliability'], author: 'Alice',
      url: 'https://linear.app/acme/issue/ENG-1', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
    });
  });

  it('marks the roles the connected account (the viewer) holds, by user id, never by name (D-012)', () => {
    // issue() is delegated to u-app (display name "Papercusp") and assigned to Bob.
    expect(internal.issueToTicket(issue(), 'u-app').selfRoles).toEqual(['delegate']);
    const app = { id: 'u-app', name: 'papercusp', displayName: 'Papercusp' };
    expect(internal.issueToTicket(issue({ assignee: app }), 'u-app').selfRoles).toEqual(['assignee', 'delegate']);
    // Another account sees the same issue as someone else's, even though a delegate is named "Papercusp".
    expect(internal.issueToTicket(issue(), 'u-other')).not.toHaveProperty('selfRoles');
    expect(internal.issueToTicket(issue())).not.toHaveProperty('selfRoles');
    expect(internal.issueToTicket(issue({ assignee: null, delegate: null }), 'u-app')).not.toHaveProperty('selfRoles');
  });

  it('a completed issue is closed with its completion time; an unassigned undelegated issue has empty people', () => {
    const ticket = internal.issueToTicket(issue({
      state: STATES.done, completedAt: '2026-10-03T10:00:00.000Z', assignee: null, delegate: null, parent: null, project: null,
      description: null, dueDate: null, estimate: null,
    }));
    expect(ticket).toMatchObject({ state: 'closed', statusCategory: 'done', closedAt: '2026-10-03T10:00:00.000Z', assignees: [], body: '' });
    for (const key of ['delegates', 'parentExternalId', 'projects', 'dueAt', 'estimate']) expect(ticket).not.toHaveProperty(key);
  });
});

describe('workflow-state history becomes ticket-status-change records', () => {
  it('emits opened once, then closed / reopened / moved by column, skipping non-state history', () => {
    const ticket = internal.issueToTicket(issue());
    const records = internal.statusChangesOf(issue({
      history: { nodes: [
        { id: 'h1', createdAt: '2026-10-01T09:00:00.000Z', fromState: STATES.todo, toState: STATES.doing, actor: { name: 'bob' } },
        { id: 'h2', createdAt: '2026-10-01T10:00:00.000Z', fromState: STATES.doing, toState: STATES.done, actor: null },
        { id: 'h3', createdAt: '2026-10-01T11:00:00.000Z', fromState: STATES.done, toState: STATES.todo, actor: null },
        { id: 'h4', createdAt: '2026-10-01T12:00:00.000Z', fromState: STATES.todo, toState: STATES.ready, actor: null },
        { id: 'h5', createdAt: '2026-10-01T13:00:00.000Z', fromState: null, toState: null, actor: null },
      ] },
    }), ticket);
    expect(records.map((r: { nativeId: string; payload: Record<string, unknown> }) => [r.nativeId, r.payload.transition, r.payload.fromCategory ?? null, r.payload.toCategory ?? null]))
      .toEqual([
        ['opened:iss-1', 'opened', null, null],
        ['history:h1', 'moved', 'todo', 'in-progress'],
        ['history:h2', 'closed', 'in-progress', 'done'],
        ['history:h3', 'reopened', 'done', 'todo'],
        ['history:h4', 'moved', 'todo', 'todo'],
      ]);
    expect(records[1].payload).toMatchObject({
      ticketExternalId: 'iss-1', fromStatusName: 'Todo', toStatusName: 'In Progress', actor: 'bob', occurredAt: '2026-10-01T09:00:00.000Z',
    });
  });
});

describe('syncPage walks issues then comments per team, folding watermarks only at the end of a pass', () => {
  it('paginates, crosses teams in config order, and filters the next pass by the newest updatedAt seen', async () => {
    const fake = fakeHost((op, vars) => {
      const filter = vars.filter as Record<string, unknown>;
      if (op === 'PapercuspIssues') {
        const team = (filter.team as { id: { eq: string } }).id.eq;
        if (team === 'team-a' && !vars.after) return page('issues', [issue()], 'cur-a1');
        if (team === 'team-a') return page('issues', [issue({ id: 'iss-2', number: 2, updatedAt: '2026-10-02T11:00:00.000Z' })]);
        return page('issues', []);
      }
      // Comments live on team-a's issue only.
      const commentTeam = ((filter.issue as { team: { id: { eq: string } } }).team).id.eq;
      if (commentTeam !== 'team-a') return page('comments', []);
      return page('comments', [{
        id: 'c-1', body: 'repro attached', url: 'https://linear.app/acme/issue/ENG-1#comment-c1',
        createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', user: { name: 'alice' }, issue: { id: 'iss-1' },
      }]);
    });
    const config = { teamIds: ['team-a', 'team-b'] };
    const pages: Array<{ hasMore: boolean; ids: string[] }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const out: { records: Array<{ nativeId: string }>; nextCursor: string | null; hasMore: boolean } =
        await adapter.syncPage({ source: SOURCE, config, cursor }, fake.host);
      pages.push({ hasMore: out.hasMore, ids: out.records.map((r: { nativeId: string }) => r.nativeId) });
      cursor = out.nextCursor;
      if (!out.hasMore) break;
    }
    expect(fake.calls.map((c) => `${c.op}:${JSON.stringify((c.variables.filter as Record<string, unknown>))}:${c.variables.after ?? ''}`)).toEqual([
      'PapercuspIssues:{"team":{"id":{"eq":"team-a"}}}:',
      'PapercuspIssues:{"team":{"id":{"eq":"team-a"}}}:cur-a1',
      'PapercuspComments:{"issue":{"team":{"id":{"eq":"team-a"}}}}:',
      'PapercuspIssues:{"team":{"id":{"eq":"team-b"}}}:',
      'PapercuspComments:{"issue":{"team":{"id":{"eq":"team-b"}}}}:',
    ]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, true, true, false]);
    expect(pages[0]!.ids).toEqual(['iss-1', 'opened:iss-1']);
    expect(pages[2]!.ids).toEqual(['comment:c-1']);

    // Next pass: the same calls, now bounded by the newest updatedAt each (team, phase) saw.
    fake.calls.length = 0;
    await adapter.syncPage({ source: SOURCE, config, cursor }, fake.host);
    expect(fake.calls[0]!.variables.filter).toEqual({ team: { id: { eq: 'team-a' } }, updatedAt: { gte: '2026-10-02T11:00:00.000Z' } });
    expect(JSON.parse(cursor!).since).toEqual({
      'team-a:issues': '2026-10-02T11:00:00.000Z',
      'team-a:comments': '2026-10-02T10:00:00.000Z',
    });
  });

  it('a changed team list starts a fresh pass that keeps the remaining teams\' watermarks', () => {
    const raw = JSON.stringify({
      v: 1, teams: ['team-a', 'team-b'], team: 1, phase: 'comments', after: 'x',
      since: { 'team-a:issues': '2026-10-01T00:00:00.000Z', 'team-b:issues': '2026-10-01T00:00:00.000Z' }, seen: {},
    });
    expect(internal.decodeCursor(raw, ['team-a', 'team-c'])).toEqual({
      v: 1, teams: ['team-a', 'team-c'], team: 0, phase: 'issues', after: null,
      since: { 'team-a:issues': '2026-10-01T00:00:00.000Z' }, seen: {},
    });
    expect(() => internal.decodeCursor('not json', ['team-a'])).toThrow(/linear_cursor_unreadable/);
    expect(() => internal.decodeCursor(JSON.stringify({ v: 2 }), ['team-a'])).toThrow(/linear_cursor_unrecognised/);
  });

  it('refuses a source with no teams', async () => {
    await expect(adapter.syncPage({ source: SOURCE, config: {}, cursor: null }, fakeHost(() => json(200, {})).host))
      .rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('linear_teams_missing') });
  });
});

describe('Linear failures map onto the host sync signals', () => {
  const config = { teamIds: ['team-a'] };
  it('RATELIMITED (Linear answers 400 with the GraphQL code) is rate-limited with the reset time', async () => {
    const resetMs = Date.now() + 90_000;
    const host = fakeHost(() => json(400, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      { 'X-RateLimit-Requests-Reset': String(resetMs) })).host;
    const err = await adapter.syncPage({ source: SOURCE, config, cursor: null }, host).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate-limited' });
    expect((err as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(85);
    expect((err as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it('HTTP 429 honours Retry-After', async () => {
    const host = fakeHost(() => json(429, {}, { 'retry-after': '12' })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, host)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 12 });
  });

  it('classifies by extensions.type too, the field @linear/sdk reads (errorMap: "ratelimited", "authentication error")', async () => {
    const limited = fakeHost(() => json(400, { errors: [{ message: 'slow down', extensions: { type: 'ratelimited' } }] }, { 'retry-after': '7' })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, limited)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 7 });
    const denied = fakeHost(() => json(400, { errors: [{ message: 'auth', extensions: { type: 'authentication error' } }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, denied)).rejects.toMatchObject({ kind: 'auth' });
    const forbidden = fakeHost(() => json(200, { errors: [{ message: 'no', extensions: { type: 'forbidden' } }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, forbidden)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('an authentication error is auth; any other GraphQL error is transient', async () => {
    const denied = fakeHost(() => json(400, { errors: [{ message: 'auth', extensions: { code: 'AUTHENTICATION_ERROR' } }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, denied)).rejects.toMatchObject({ kind: 'auth' });
    const broken = fakeHost(() => json(200, { errors: [{ message: 'Cannot query field "x"' }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, broken))
      .rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('Cannot query field') });
  });
});

describe('ticket.containers lists the teams the source can sync (D-014)', () => {
  const containers = (host: { fetch: HostFetch }, config: Record<string, unknown> = {}) =>
    adapter.invoke({ source: SOURCE, capability: 'ticket.containers', args: {}, config }, host);

  it('pages through every team, sorted by name, with the UUID teamIds expects and the key as a label', async () => {
    const fake = fakeHost((op, vars) => {
      expect(op).toBe('PapercuspTeams');
      if (vars.after === null) {
        return page('teams', [{ id: 'team-b', key: 'OPS', name: 'Operations' }, { id: 'team-a', key: 'ENG', name: 'Engineering' }], 'c1');
      }
      expect(vars.after).toBe('c1');
      // A team seen on an earlier page is listed once.
      return page('teams', [{ id: 'team-c', key: 'DES', name: 'Design' }, { id: 'team-a', key: 'ENG', name: 'Engineering' }]);
    });
    await expect(containers(fake.host)).resolves.toEqual({
      truncated: false,
      containers: [
        { id: 'team-c', name: 'Design', kind: 'team', key: 'DES' },
        { id: 'team-a', name: 'Engineering', kind: 'team', key: 'ENG' },
        { id: 'team-b', name: 'Operations', kind: 'team', key: 'OPS' },
      ],
    });
    expect(fake.calls.map((c) => c.op)).toEqual(['PapercuspTeams', 'PapercuspTeams']);
  });

  it('needs no teamIds (a freshly connected source has none) and reads nothing but teams', async () => {
    const fake = fakeHost(() => page('teams', [{ id: 'team-a', key: 'ENG', name: 'Engineering' }]));
    await expect(containers(fake.host, {})).resolves.toMatchObject({ containers: [{ id: 'team-a' }] });
    expect(fake.calls.every((c) => /query PapercuspTeams/.test(JSON.parse(String(c.request.body)).query))).toBe(true);
    expect(fake.calls.every((c) => c.request.headers?.authorization === undefined)).toBe(true);
  });

  it('stops after 20 pages and says the list is truncated', async () => {
    let n = 0;
    const fake = fakeHost(() => { n++; return page('teams', [{ id: `team-${n}`, key: `T${n}`, name: `Team ${n}` }], `c${n}`); });
    const result = await containers(fake.host);
    expect(fake.calls).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.containers).toHaveLength(20);
  });

  it('maps an auth failure onto the auth signal', async () => {
    const fake = fakeHost(() => json(401, { errors: [{ message: 'auth', extensions: { code: 'AUTHENTICATION_ERROR' } }] }));
    await expect(containers(fake.host)).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('writes: ticket.comment and ticket.transition', () => {
  it('comments through commentCreate and returns the comment phase\'s nativeId as updateId', async () => {
    const fake = fakeHost((op, vars) => {
      expect(op).toBe('PapercuspCommentCreate');
      expect(vars.input).toEqual({ issueId: 'iss-1', body: 'Picked up by Papercusp.' });
      return json(200, { data: { commentCreate: { success: true, comment: { id: 'c-9', url: 'https://linear.app/c/9' } } } });
    });
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.comment', args: { externalId: 'iss-1', text: ' Picked up by Papercusp. ' } }, fake.host))
      .resolves.toEqual({ externalRef: 'https://linear.app/c/9', updateId: 'comment:c-9' });
  });

  function statesHost(current: { id: string; name: string; type: string }, onUpdate: (stateId: string) => void) {
    return fakeHost((op, vars) => {
      if (op === 'PapercuspIssueStates') {
        return json(200, { data: { issue: { id: 'iss-1', state: current, team: { id: 'team-a', states: { nodes: Object.values(STATES) } } } } });
      }
      expect(op).toBe('PapercuspIssueTransition');
      onUpdate((vars.input as { stateId: string }).stateId);
      return json(200, { data: { issueUpdate: { success: true, issue: { id: 'iss-1', updatedAt: 'x', state: current } } } });
    });
  }

  it('moves to the first state (by position) of the mapped type, preferring review-named states only for in-review', async () => {
    const moves: string[] = [];
    for (const toCategory of ['todo', 'in-progress', 'in-review', 'done', 'canceled', 'backlog', 'triage']) {
      // The issue sits in a backlog state, so a move to backlog is a no-op (changed: false).
      const fake = statesHost({ id: 'st-icebox', name: 'Icebox', type: 'backlog' }, (id) => moves.push(`${toCategory}->${id}`));
      const out = await adapter.invoke({ source: SOURCE, capability: 'ticket.transition', args: { externalId: 'iss-1', toCategory } }, fake.host);
      if (toCategory !== 'backlog') expect(out).toMatchObject({ changed: true, externalRef: 'iss-1' });
    }
    expect(moves).toEqual([
      'todo->st-todo', 'in-progress->st-doing', 'in-review->st-review', 'done->st-done', 'canceled->st-canceled', 'triage->st-triage',
    ]);
  });

  it('declares ticket.create and ticket.containers beside the writes', async () => {
    expect((await adapter.describe()).capabilities).toEqual(['ticket.read', 'ticket.create', 'ticket.comment', 'ticket.transition', 'ticket.containers']);
  });

  it('leaves an issue already in the column alone, and refuses an unknown column or a capability it lacks', async () => {
    let updated = false;
    const fake = statesHost(STATES.done, () => { updated = true; });
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.transition', args: { externalId: 'iss-1', toCategory: 'done' } }, fake.host))
      .resolves.toMatchObject({ changed: false });
    expect(updated).toBe(false);
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.transition', args: { externalId: 'iss-1', toCategory: 'shipped' } }, fake.host))
      .rejects.toThrow(/transition_category_invalid:shipped/);
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.assign', args: {} }, fake.host))
      .rejects.toThrow(/provider_capability_unsupported:ticket.assign/);
  });
});

/**
 * ticket.create (plan cupboard-distributable-integrations-2026-10-10 P-007, AUTO-BAR-R-5-P-007): the
 * provider-neutral create the bug-triage workflow files through. The issue id is chosen by the
 * caller and derived from the correlation id, so a retry finds the issue an earlier attempt made.
 */
describe('ticket.create files one issue per correlation id in a configured team', () => {
  const CONFIG = { teamIds: ['team-eng'] };
  const ARGS = { containerId: 'team-eng', correlationId: 'papercusp-ticket-abc', title: 'Export crashes', body: 'Observed: crash.' };
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const create = (host: { fetch: HostFetch }, args: Record<string, unknown> = ARGS, config: Record<string, unknown> = CONFIG) =>
    adapter.invoke({ source: SOURCE, capability: 'ticket.create', args, config }, host);

  /** A Linear workspace holding `issues` by id; issueCreate stores the issue under the id it was given. */
  function linear(
    issues = new Map<string, { id: string; url: string; team: { id: string }; assignee?: { id: string } | null }>(),
    opts: { loseCreateResponse?: boolean } = {},
  ) {
    const created: Array<Record<string, unknown>> = [];
    const fake = fakeHost((op, vars) => {
      if (op === 'PapercuspViewer') return json(200, { data: { viewer: { id: 'viewer-papercusp' } } });
      if (op === 'PapercuspIssueById') {
        const found = issues.get(String(vars.id));
        return json(200, { data: { issues: { nodes: found ? [{ ...found, identifier: 'ENG-1' }] : [] } } });
      }
      expect(op).toBe('PapercuspIssueCreate');
      const input = vars.input as { id: string; teamId: string; assigneeId?: string };
      created.push(input);
      issues.set(input.id, { id: input.id, url: `https://linear.app/acme/issue/ENG-${created.length}`, team: { id: input.teamId },
        assignee: input.assigneeId ? { id: input.assigneeId } : null });
      if (opts.loseCreateResponse) return json(502, {});
      return json(200, { data: { issueCreate: { success: true, issue: { ...issues.get(input.id), identifier: `ENG-${created.length}` } } } });
    });
    return { ...fake, created, issues };
  }

  it('creates the issue in the team with a UUID derived from the correlation id, and a second call recovers it', async () => {
    const remote = linear();
    const first = await create(remote.host);
    expect(remote.created).toHaveLength(1);
    const input = remote.created[0] as { id: string; teamId: string; title: string; description: string };
    expect(input).toEqual({ id: expect.stringMatching(UUID_V4), teamId: 'team-eng', title: 'Export crashes', description: 'Observed: crash.' });
    expect(first).toEqual({ externalRef: input.id, url: 'https://linear.app/acme/issue/ENG-1', recovered: false });

    const again = await create(remote.host);
    expect(again).toEqual({ externalRef: input.id, url: 'https://linear.app/acme/issue/ENG-1', recovered: true });
    expect(remote.created).toHaveLength(1);
    // The lookup that answered the retry asked for exactly that id, archived issues included.
    const lookups = remote.calls.filter((c) => c.op === 'PapercuspIssueById');
    expect(lookups.map((c) => c.variables.id)).toEqual([input.id, input.id]);
    expect(JSON.parse(String(lookups[0].request.body)).query).toContain('includeArchived: true');
  });

  it('derives a different issue id for a different correlation id', async () => {
    const remote = linear();
    await create(remote.host);
    await create(remote.host, { ...ARGS, correlationId: 'papercusp-ticket-def' });
    expect(remote.created).toHaveLength(2);
    expect((remote.created[0] as { id: string }).id).not.toBe((remote.created[1] as { id: string }).id);
  });

  it('a recovery-only call never creates: it answers pending until the issue exists', async () => {
    const remote = linear();
    await expect(create(remote.host, { ...ARGS, recoveryOnly: true })).resolves.toEqual({ pendingReconciliation: true });
    expect(remote.created).toHaveLength(0);
  });

  it('a create whose response is lost is answered by the issue Linear made, not a second create', async () => {
    const remote = linear(undefined, { loseCreateResponse: true });
    const out = await create(remote.host);
    expect(out).toMatchObject({ recovered: true, externalRef: (remote.created[0] as { id: string }).id });
    expect(remote.created).toHaveLength(1);
  });

  it('refuses a team the source is not configured for, before any Linear call', async () => {
    const remote = linear();
    await expect(create(remote.host, { ...ARGS, containerId: 'team-other' })).rejects.toThrow('ticket_create_project_out_of_scope');
    await expect(create(remote.host, ARGS, {})).rejects.toThrow('ticket_create_project_out_of_scope');
    await expect(create(remote.host, { ...ARGS, correlationId: '' })).rejects.toThrow('ticket_create_correlation_required');
    await expect(create(remote.host, { ...ARGS, title: '' })).rejects.toThrow('ticket_create_content_invalid');
    expect(remote.calls).toHaveLength(0);
  });

  it("assignee 'self' assigns the issue to the connected account (the viewer) and the receipt confirms it", async () => {
    const remote = linear();
    const out = await create(remote.host, { ...ARGS, assignee: 'self' });
    const input = remote.created[0] as { id: string; assigneeId?: string };
    expect(input.assigneeId).toBe('viewer-papercusp');
    expect(out).toEqual({ externalRef: input.id, url: 'https://linear.app/acme/issue/ENG-1', recovered: false, assignee: 'self' });
    // A recovery of the same issue confirms the assignee from the issue Linear holds.
    expect(await create(remote.host, { ...ARGS, assignee: 'self', recoveryOnly: true })).toMatchObject({ recovered: true, assignee: 'self' });
    expect(remote.created).toHaveLength(1);
  });

  it('without the option nothing asks for the viewer; a recovered issue assigned to someone else is not confirmed', async () => {
    const remote = linear();
    const out = await create(remote.host);
    expect(out).not.toHaveProperty('assignee');
    expect(remote.calls.map((c) => c.op)).not.toContain('PapercuspViewer');
    expect(remote.created[0]).not.toHaveProperty('assigneeId');
    const id = (remote.created[0] as { id: string }).id;
    remote.issues.set(id, { ...remote.issues.get(id)!, assignee: { id: 'someone-else' } });
    expect(await create(remote.host, { ...ARGS, assignee: 'self' })).not.toHaveProperty('assignee');
    expect(remote.created).toHaveLength(1);
  });

  it('refuses an assignee other than self before any Linear call', async () => {
    const remote = linear();
    await expect(create(remote.host, { ...ARGS, assignee: 'user-123' })).rejects.toThrow('ticket_create_assignee_invalid');
    expect(remote.calls).toHaveLength(0);
  });

  it('an existing issue with that id in another team is a scope violation, not a recovery', async () => {
    const remote = linear();
    await create(remote.host);
    const id = (remote.created[0] as { id: string }).id;
    remote.issues.set(id, { ...remote.issues.get(id)!, team: { id: 'team-other' } });
    await expect(create(remote.host)).rejects.toThrow('ticket_create_recovery_scope_invalid');
    expect(remote.created).toHaveLength(1);
  });

  it('ticket.containers { purpose: create } offers only the configured teams the app can read', async () => {
    const fake = fakeHost(() => page('teams', [
      { id: 'team-eng', key: 'ENG', name: 'Engineering' },
      { id: 'team-ops', key: 'OPS', name: 'Operations' },
    ]));
    const config = { teamIds: ['team-eng', 'team-gone'] };
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.containers', args: { purpose: 'create' }, config }, fake.host))
      .resolves.toEqual({ containers: [{ id: 'team-eng', name: 'Engineering', kind: 'team', key: 'ENG' }], truncated: false });
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.containers', args: {}, config }, fake.host))
      .resolves.toMatchObject({ containers: [{ id: 'team-eng' }, { id: 'team-ops' }] });
  });
});
