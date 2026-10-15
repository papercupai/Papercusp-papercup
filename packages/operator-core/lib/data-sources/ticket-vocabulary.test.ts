/**
 * linear-asana-task-sync-2026-10-05 P-001 — the canonical ticket datatypes widened for
 * workflow trackers (migration 1377 on top of 1332), and the TypeScript vocabulary that
 * states the same categories.
 *
 * The schemas are read from the migration files themselves: 1332's seed payload_schema
 * literals, plus 1377's property patches (between its PATCH markers). 1377 merges each
 * patch into payload_schema->'properties' with jsonb `||`, which replaces top-level keys
 * exactly like an object spread, so the merge below is the migration's own semantics.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import {
  TICKET_STATUS_CATEGORIES,
  isTicketStatusCategory,
  ticketStateForCategory,
  ticketTransitionBetween,
  type TicketStatusCategory,
} from './ticket-vocabulary';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SQL_DIR = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const M1332 = readFileSync(join(SQL_DIR, '1332-ticket-datatypes.sql'), 'utf8');
const M1377 = readFileSync(join(SQL_DIR, '1377-ticket-workflow-tracker-fields.sql'), 'utf8');
const M1397 = readFileSync(join(SQL_DIR, '1397-ticket-self-roles.sql'), 'utf8');

type Schema = { properties: Record<string, Record<string, unknown>>; allOf?: unknown[]; [k: string]: unknown };

/** The payload_schema literal of one 1332 seed row. */
function seededSchema(id: string): Schema {
  const row = new RegExp(`\\(\\s*'${id}', 'papercusp-workspace'[\\s\\S]*?'(\\{"type":"object"[^']*)'::jsonb`).exec(M1332);
  if (!row) throw new Error(`1332 has no seed row for ${id}: the migration format changed, fix this parser`);
  return JSON.parse(row[1]!) as Schema;
}

/** The JSON literal a migration (1377 by default) places between `-- <marker>-BEGIN` and `-- <marker>-END`. */
function patch<T = Record<string, Record<string, unknown>>>(marker: string, migration = M1377): T {
  const m = new RegExp(`-- ${marker}-BEGIN\\s*'([^']*)'::jsonb\\s*-- ${marker}-END`).exec(migration);
  if (!m) throw new Error(`migration has no ${marker} block: the migration format changed, fix this parser`);
  return JSON.parse(m[1]!) as T;
}

const base1332Ticket = seededSchema('ticket');
const base1332StatusChange = seededSchema('ticket-status-change');
const ticketPatch = patch('TICKET-PATCH');
const statusChangePatch = patch('STATUS-CHANGE-PATCH');
const statusChangeAllOf = patch<unknown[]>('STATUS-CHANGE-ALLOF');
const selfRolesPatch = patch('SELF-ROLES-PATCH', M1397);

const ticketSchema: Schema = {
  ...base1332Ticket,
  properties: { ...base1332Ticket.properties, ...ticketPatch, ...selfRolesPatch },
};
const statusChangeSchema: Schema = {
  ...base1332StatusChange,
  properties: { ...base1332StatusChange.properties, ...statusChangePatch },
  allOf: statusChangeAllOf,
};

function valid(schema: Schema, value: unknown): boolean {
  return checkAgainstJsonSchema(schema, value).ok;
}

/** A payload that carries a category must carry the open/closed state derived from it. */
function expectStateDerived(payload: { state: string; statusCategory?: string }): void {
  if (payload.statusCategory === undefined) return;
  expect(isTicketStatusCategory(payload.statusCategory)).toBe(true);
  expect(payload.state).toBe(ticketStateForCategory(payload.statusCategory as TicketStatusCategory));
}

const GITHUB_1332_TICKET = {
  provider: 'github', externalId: 'acme/orchid#1', container: 'acme/orchid', number: 1,
  title: 'Crash on start', body: 'Steps…', state: 'closed', stateReason: 'completed',
  author: 'alice-gh', assignees: ['bob-gh'], labels: ['bug'], url: 'https://github.com/acme/orchid/issues/1',
  createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', closedAt: '2026-10-01T09:00:00.000Z',
};

const LINEAR_TICKET = {
  provider: 'linear', externalId: '6f1c2c1e-0b0a-4d9e-9a51-2b1c1f0e9a77', container: 'ENG', identifier: 'ENG-123',
  title: 'Sync stalls after token refresh', body: '…', state: 'open', statusCategory: 'in-progress',
  statusName: 'In Progress', priority: { level: 2, name: 'High' }, dueAt: '2026-10-10',
  parentExternalId: '9d0e7a52-6a55-4f1f-8d0e-0c3f6d2a1b44', projects: ['Integrations'], estimate: 3,
  assignees: ['avi@example.com'], delegates: ['papercusp-agent'], labels: ['backend'], selfRoles: ['delegate'],
  url: 'https://linear.app/acme/issue/ENG-123',
};

const ASANA_TICKET = {
  provider: 'asana', externalId: '1209876543210123', container: '1209000000000001',
  title: 'Draft launch checklist', state: 'open', statusCategory: 'todo', section: 'Up next',
  projects: ['1209000000000001', '1209000000000002'], dueAt: '2026-10-14T17:00:00.000Z',
  assignees: ['Papercusp'], selfRoles: ['assignee'],
};

describe('migration 1377: ticket datatypes widened for workflow trackers', () => {
  it('pins the TypeScript category list to every category enum in the migration', () => {
    expect(ticketPatch.statusCategory!.enum).toEqual([...TICKET_STATUS_CATEGORIES]);
    expect(statusChangePatch.fromCategory!.enum).toEqual([...TICKET_STATUS_CATEGORIES]);
    expect(statusChangePatch.toCategory!.enum).toEqual([...TICKET_STATUS_CATEGORIES]);
  });

  it('is additive: no 1332 ticket property is replaced, and transition keeps every 1332 value', () => {
    expect(Object.keys(ticketPatch).filter((k) => k in base1332Ticket.properties)).toEqual([]);
    expect(ticketSchema.required).toEqual(base1332Ticket.required);
    const replaced = Object.keys(statusChangePatch).filter((k) => k in base1332StatusChange.properties);
    expect(replaced).toEqual(['transition']);
    const before = base1332StatusChange.properties.transition!.enum as string[];
    const after = statusChangePatch.transition!.enum as string[];
    expect(after.filter((t) => !before.includes(t))).toEqual(['moved']);
    expect(before.every((t) => after.includes(t))).toBe(true);
    expect(statusChangeSchema.required).toEqual(base1332StatusChange.required);
  });

  it('still accepts a payload that was valid under 1332', () => {
    expect(valid(base1332Ticket, GITHUB_1332_TICKET)).toBe(true);
    expect(valid(ticketSchema, GITHUB_1332_TICKET)).toBe(true);
    const closed = { provider: 'github', externalId: 'event:501', ticketExternalId: 'acme/orchid#1', transition: 'closed', actor: 'alice-gh' };
    expect(valid(base1332StatusChange, closed)).toBe(true);
    expect(valid(statusChangeSchema, closed)).toBe(true);
  });

  it('accepts Linear- and Asana-shaped tickets carrying the new workflow fields', () => {
    for (const ticket of [LINEAR_TICKET, ASANA_TICKET]) {
      const check = checkAgainstJsonSchema(ticketSchema, ticket);
      expect(check, JSON.stringify(check)).toEqual({ ok: true });
      expectStateDerived(ticket);
    }
    // 1332 alone could not say the ticket is mid-workflow; the patch is what makes it meaningful.
    expect(ticketPatch.statusCategory).toBeDefined();
  });

  it('rejects malformed workflow fields', () => {
    expect(valid(ticketSchema, { ...LINEAR_TICKET, statusCategory: 'doing' })).toBe(false);
    expect(valid(ticketSchema, { ...LINEAR_TICKET, priority: { level: 5, name: 'Whenever' } })).toBe(false);
    expect(valid(ticketSchema, { ...LINEAR_TICKET, priority: { level: 1.5 } })).toBe(false);
    expect(valid(ticketSchema, { ...ASANA_TICKET, projects: '1209000000000001' })).toBe(false);
    expect(valid(ticketSchema, { ...LINEAR_TICKET, delegates: [42] })).toBe(false);
    expect(valid(ticketSchema, { ...LINEAR_TICKET, estimate: 'three' })).toBe(false);
  });

  it('adds a `moved` transition that must name the category it moved to', () => {
    const moved = {
      provider: 'linear', externalId: 'history:abc', ticketExternalId: LINEAR_TICKET.externalId,
      transition: 'moved', fromCategory: 'todo', toCategory: 'in-progress', fromStatusName: 'Todo', toStatusName: 'In Progress',
    };
    expect(valid(statusChangeSchema, moved)).toBe(true);
    expect(valid(base1332StatusChange, moved)).toBe(false); // genuinely new: 1332 refused it
    const { toCategory: _dropped, ...withoutTo } = moved;
    expect(valid(statusChangeSchema, withoutTo)).toBe(false);
    expect(valid(statusChangeSchema, { ...moved, toCategory: 'shipped' })).toBe(false);
    expect(valid(statusChangeSchema, { ...moved, transition: 'archived' })).toBe(false);
    // The toCategory requirement binds `moved` only; an old-shape close needs no category.
    expect(valid(statusChangeSchema, { ...withoutTo, transition: 'closed' })).toBe(true);
  });
});

describe('migration 1397: ticket.selfRoles (D-012)', () => {
  it('adds only selfRoles, optional, without replacing a 1332 or 1377 property', () => {
    expect(Object.keys(selfRolesPatch)).toEqual(['selfRoles']);
    expect(base1332Ticket.properties.selfRoles).toBeUndefined();
    expect(ticketPatch.selfRoles).toBeUndefined();
    expect((base1332Ticket.required as string[] | undefined) ?? []).not.toContain('selfRoles');
  });

  it('accepts the roles the providers emit, and a ticket without selfRoles', () => {
    expect(valid(ticketSchema, { ...LINEAR_TICKET, selfRoles: ['assignee', 'delegate'] })).toBe(true);
    const { selfRoles: _omitted, ...withoutRoles } = ASANA_TICKET;
    expect(valid(ticketSchema, withoutRoles)).toBe(true);
  });

  it('rejects a role outside assignee|delegate, a repeated role and a non-array', () => {
    expect(valid(ticketSchema, { ...LINEAR_TICKET, selfRoles: ['watcher'] })).toBe(false);
    expect(valid(ticketSchema, { ...LINEAR_TICKET, selfRoles: ['delegate', 'delegate'] })).toBe(false);
    expect(valid(ticketSchema, { ...ASANA_TICKET, selfRoles: 'assignee' })).toBe(false);
  });
});

describe('ticket vocabulary', () => {
  it('derives open/closed from the category: only done and canceled are closed', () => {
    const closed = TICKET_STATUS_CATEGORIES.filter((c) => ticketStateForCategory(c) === 'closed');
    expect(closed).toEqual(['done', 'canceled']);
    expect(isTicketStatusCategory('in-review')).toBe(true);
    expect(isTicketStatusCategory('In Review')).toBe(false);
    expect(isTicketStatusCategory(undefined)).toBe(false);
  });

  it('names the transition for a category change', () => {
    expect(ticketTransitionBetween(undefined, 'triage')).toBe('opened');
    expect(ticketTransitionBetween(null, 'done')).toBe('opened');
    expect(ticketTransitionBetween('todo', 'todo')).toBeNull();
    expect(ticketTransitionBetween('todo', 'in-progress')).toBe('moved');
    expect(ticketTransitionBetween('in-review', 'done')).toBe('closed');
    expect(ticketTransitionBetween('backlog', 'canceled')).toBe('closed');
    expect(ticketTransitionBetween('done', 'in-progress')).toBe('reopened');
    expect(ticketTransitionBetween('done', 'canceled')).toBe('moved');
  });
});

describe('github-issues provider fills statusCategory', () => {
  const plugin = createRequire(import.meta.url)(join(REPO_ROOT, 'libs/papercusp/plugins/github-issues/index.cjs')) as {
    providerAdapter: { invoke(request: unknown, host: unknown): Promise<{ ticket: Record<string, unknown> }> };
  };

  async function readIssue(issue: Record<string, unknown>): Promise<Record<string, unknown>> {
    const host = {
      fetch: async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ id: 1, number: 7, title: 'An issue', body: '', user: { login: 'alice-gh' }, ...issue }),
      }),
    };
    const out = await plugin.providerAdapter.invoke(
      { source: 'src-1', capability: 'ticket.read', args: { externalId: 'acme/orchid#7' } },
      host,
    );
    return out.ticket;
  }

  it.each([
    [{ state: 'open' }, 'todo'],
    [{ state: 'closed', state_reason: 'completed' }, 'done'],
    [{ state: 'closed' }, 'done'],
    [{ state: 'closed', state_reason: 'not_planned' }, 'canceled'],
    [{ state: 'closed', state_reason: 'duplicate' }, 'canceled'],
    [{ state: 'open', state_reason: 'reopened' }, 'todo'],
  ])('%j -> %s, with state derived and the payload schema-valid', async (issue, category) => {
    const ticket = await readIssue(issue);
    expect(ticket.statusCategory).toBe(category);
    expectStateDerived(ticket as { state: string; statusCategory?: string });
    const check = checkAgainstJsonSchema(ticketSchema, ticket);
    expect(check, JSON.stringify(check)).toEqual({ ok: true });
  });
});
