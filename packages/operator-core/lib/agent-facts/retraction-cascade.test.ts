/**
 * P-003 / R-3 — a fact's retraction or supersession reaches the closed work items
 * whose completion assumptions cited it: each gets a visible flag naming the fact
 * and the reason, its terminal owner is told, and nothing is reopened.
 *
 * Falsifier pinned here: "a completion that cited a now-retracted fact carries no
 * flag". The DB seam is a fake tagged-template `sql` that keeps work items in
 * memory, so these tests run the real matcher, the real UPDATE statement routing
 * and the real notice renderer.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

const sendMessage = vi.fn(async (_identity: unknown, _opts: Record<string, unknown>) => ({}) as unknown);
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: (identity: unknown, opts: Record<string, unknown>) => sendMessage(identity, opts),
}));

import {
  ASSUMPTION_FLAGS_KEY,
  buildFlag,
  cascadeFactChange,
  citesChangedFact,
  dedupeKeyOf,
  factRefOf,
  mergeFlags,
  readAssumptionFlags,
  renderCascadeNotice,
  renderFlagLine,
  supersessionChangedBody,
  type AssumptionFlag,
  type FactChangeEvent,
} from './retraction-cascade';

const WS = 'ws-test';
const NOW = () => new Date('2026-10-14T14:00:00.000Z');

const retraction = (over: Partial<FactChangeEvent> = {}): FactChangeEvent => ({
  kind: 'retracted',
  workspaceId: WS,
  scope: 'harness',
  scopeRef: 'papercusp',
  key: 'release-window',
  versionId: 42,
  reason: 'window moved to Friday',
  by: 'su-retractor',
  ...over,
});

const supersession = (over: Partial<FactChangeEvent> = {}): FactChangeEvent => ({
  kind: 'superseded',
  workspaceId: WS,
  scope: 'harness',
  scopeRef: 'papercusp',
  key: 'release-window',
  versionId: 42,
  supersededBy: 43,
  reason: 'superseded by version 43',
  by: 'su-writer',
  ...over,
});

const citation = (over: Record<string, unknown> = {}) => ({
  declared: 'harness:papercusp:release-window',
  ref: 'harness:papercusp:release-window@42',
  key: 'release-window',
  scope: 'harness',
  scopeRef: 'papercusp',
  versionId: 42,
  condition: 'live',
  ...over,
});

interface Item {
  feature_id: string;
  harness_slug: string | null;
  title: string;
  status: string;
  terminal_owner: string | null;
  taken_by: string | null;
  payload: Record<string, unknown>;
}

const item = (id: string, declared: unknown, over: Partial<Item> = {}): Item => ({
  feature_id: id,
  harness_slug: 'papercusp',
  title: `item ${id}`,
  status: 'done',
  terminal_owner: 'su-closer',
  taken_by: null,
  payload: { _assumptions: { declared, resolvedAt: '2026-10-01T00:00:00Z' } },
  ...over,
});

/** jsonb `@>` for the two probe shapes the cascade uses (array of partial objects). */
const contains = (arr: unknown, probe: Record<string, unknown>[]): boolean =>
  Array.isArray(arr) &&
  probe.every((p) =>
    arr.some((el) => el && typeof el === 'object' && Object.entries(p).every(([k, v]) => (el as Record<string, unknown>)[k] === v)),
  );

const TERMINAL = new Set(['resolved', 'closed', 'deprecated', 'done', 'dropped', 'shipped', 'verified']);

/** In-memory work_items behind a tagged-template fake. Records every statement. */
function fakeSql(items: Item[], opts: { failSelect?: boolean; bodies?: Record<number, string> } = {}) {
  const statements: string[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    statements.push(text);
    if (text.includes('FROM harness_shared.agent_facts')) {
      const id = values[0] as number;
      return opts.bodies && id in opts.bodies ? [{ body: opts.bodies[id] }] : [];
    }
    if (text.includes('SELECT feature_id')) {
      if (opts.failSelect) throw new Error('relation "harness_shared.work_items" does not exist');
      const [ws, probeJson, states, limit] = values as [string, string, string[], number];
      const probe = JSON.parse(probeJson) as Record<string, unknown>[];
      return items
        .filter((i) => ws === WS)
        .filter((i) => {
          const declared = (i.payload._assumptions as { declared?: unknown } | undefined)?.declared;
          return Array.isArray(declared) && contains(declared, probe) && states.includes(i.status);
        })
        .slice(0, limit)
        .map((i) => ({
          feature_id: i.feature_id,
          harness_slug: i.harness_slug,
          title: i.title,
          status: i.status,
          terminal_owner: i.terminal_owner,
          taken_by: i.taken_by,
          declared: (i.payload._assumptions as { declared: unknown }).declared,
        }));
    }
    if (text.includes('UPDATE harness_shared.work_items')) {
      const [flagJson, , id, harness, guardJson] = values as [string, string, string, string | null, string];
      const target = items.find((i) => i.feature_id === id && i.harness_slug === harness);
      if (!target) return [];
      const existing = (target.payload[ASSUMPTION_FLAGS_KEY] as unknown[] | undefined) ?? [];
      if (contains(existing, JSON.parse(guardJson))) return [];
      target.payload[ASSUMPTION_FLAGS_KEY] = [...existing, ...JSON.parse(flagJson)];
      return [{ feature_id: id }];
    }
    throw new Error(`unexpected statement: ${text}`);
  };
  return { sql: fn as unknown as Sql, statements };
}

beforeEach(() => sendMessage.mockClear());

describe('citesChangedFact', () => {
  it('retraction matches ANY version of the cited identity', () => {
    expect(citesChangedFact(citation({ versionId: 7 }), retraction())).toBe(true);
    expect(citesChangedFact(citation({ versionId: null }), retraction())).toBe(true);
  });

  it('supersession matches only the exact superseded version', () => {
    expect(citesChangedFact(citation({ versionId: 42 }), supersession())).toBe(true);
    expect(citesChangedFact(citation({ versionId: 41 }), supersession())).toBe(false);
    expect(citesChangedFact(citation({ versionId: null }), supersession())).toBe(false);
  });

  it('a different key, scope or scopeRef never matches', () => {
    expect(citesChangedFact(citation({ key: 'other' }), retraction())).toBe(false);
    expect(citesChangedFact(citation({ scope: 'owner' }), retraction())).toBe(false);
    expect(citesChangedFact(citation({ scopeRef: 'oddsmith' }), retraction())).toBe(false);
  });

  it("workspace scope treats a null and an '' scopeRef as the same identity", () => {
    const e = retraction({ scope: 'workspace', scopeRef: '' });
    expect(citesChangedFact(citation({ scope: 'workspace', scopeRef: null }), e)).toBe(true);
  });
});

describe('flag construction and merge', () => {
  it('names the fact (absolute versioned ref) and the reason', () => {
    const f = buildFlag(retraction(), citation(), '2026-10-14T14:00:00.000Z');
    expect(f.factRef).toBe('harness:papercusp:release-window@42');
    expect(f.reason).toBe('window moved to Friday');
    expect(f.condition).toBe('retracted');
    expect(renderFlagLine(f)).toContain('harness:papercusp:release-window@42 RETRACTED by su-retractor');
    expect(renderFlagLine(f)).toContain('window moved to Friday');
  });

  it('a retraction without a reason still renders one, never an empty string', () => {
    expect(buildFlag(retraction({ reason: null }), citation(), 'x').reason).toBe('retracted (no reason given)');
  });

  it('factRefOf follows the assumption-ref grammar for workspace scope', () => {
    expect(factRefOf('workspace', null, 'k', 3)).toBe('workspace:k@3');
  });

  it('mergeFlags is idempotent by dedupeKey', () => {
    const f = buildFlag(retraction(), citation(), 'x');
    const first = mergeFlags([], [f]);
    const again = mergeFlags(first.flags, [f]);
    expect(first.added).toHaveLength(1);
    expect(again.added).toHaveLength(0);
    expect(again.flags).toHaveLength(1);
    expect(dedupeKeyOf(retraction())).not.toBe(dedupeKeyOf(supersession()));
  });

  it('readAssumptionFlags tolerates absent, string-encoded and garbage payloads', () => {
    const f = buildFlag(retraction(), citation(), 'x');
    expect(readAssumptionFlags(null)).toEqual([]);
    expect(readAssumptionFlags({ [ASSUMPTION_FLAGS_KEY]: JSON.stringify([f]) })).toHaveLength(1);
    expect(readAssumptionFlags({ [ASSUMPTION_FLAGS_KEY]: [{ nope: 1 }, f] })).toEqual([f]);
  });
});

describe('cascadeFactChange', () => {
  it('flags EVERY closed item citing a retracted fact, naming the fact and reason', async () => {
    const items = [
      item('WI-1', [citation()]),
      item('WI-2', [citation({ versionId: 40 })]),
      item('WI-3', [citation({ key: 'unrelated' })]),
    ];
    const { sql } = fakeSql(items);
    const r = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.flagged.map((i) => i.id).sort()).toEqual(['WI-1', 'WI-2']);
    for (const id of ['WI-1', 'WI-2']) {
      const flags = readAssumptionFlags(items.find((i) => i.feature_id === id)!.payload);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject<Partial<AssumptionFlag>>({
        condition: 'retracted',
        factRef: 'harness:papercusp:release-window@42',
        reason: 'window moved to Friday',
        at: '2026-10-14T14:00:00.000Z',
      });
    }
    expect(readAssumptionFlags(items[2].payload)).toEqual([]);
  });

  it('flags but NEVER reopens: the UPDATE writes payload only', async () => {
    const items = [item('WI-1', [citation()])];
    const { sql, statements } = fakeSql(items);
    await cascadeFactChange(sql, retraction(), { now: NOW });
    const update = statements.find((s) => s.includes('UPDATE harness_shared.work_items'))!;
    const setClause = update.slice(update.indexOf('SET'), update.indexOf('WHERE'));
    expect(setClause).toMatch(/payload\s*=/);
    expect(setClause).not.toMatch(/\bstatus\b|\bupdated_ts\b|\btaken_by\b|\bterminal_/);
    expect(items[0].status).toBe('done');
  });

  it('notifies the terminal owner, one message per owner listing every flagged item', async () => {
    const items = [
      item('WI-1', [citation()]),
      item('WI-2', [citation()]),
      item('WI-3', [citation()], { terminal_owner: 'su-other' }),
    ];
    const { sql } = fakeSql(items);
    const r = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(r.notified.sort()).toEqual(['su-closer', 'su-other']);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const toCloser = sendMessage.mock.calls.find((c) => (c[1].to as string[])[0] === 'su-closer')![1];
    expect(toCloser.body).toContain('WI-1');
    expect(toCloser.body).toContain('WI-2');
    expect(toCloser.body).toContain('window moved to Friday');
    expect(toCloser.summary).toContain('harness:papercusp:release-window@42');
    // Default-included in coord:inbox: no category.
    expect(toCloser).not.toHaveProperty('category');
  });

  it('falls back to the claim holder when no terminal owner was recorded', async () => {
    const items = [item('WI-1', [citation()], { terminal_owner: null, taken_by: 'su-holder' })];
    const { sql } = fakeSql(items);
    const r = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(r.notified).toEqual(['su-holder']);
  });

  it('reports items with no resolvable owner instead of dropping them silently', async () => {
    const items = [item('WI-1', [citation()], { terminal_owner: null, taken_by: null })];
    const { sql } = fakeSql(items);
    const r = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(r.flagged).toHaveLength(1);
    expect(r.unnotifiable).toEqual(['WI-1']);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is idempotent: a replayed event adds no second flag and sends no second notice', async () => {
    const items = [item('WI-1', [citation()])];
    const { sql } = fakeSql(items);
    await cascadeFactChange(sql, retraction(), { now: NOW });
    const second = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(second.matched).toBe(1);
    expect(second.flagged).toEqual([]);
    expect(readAssumptionFlags(items[0].payload)).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('supersession flags only closes pinned to the superseded version', async () => {
    const items = [item('WI-1', [citation({ versionId: 42 })]), item('WI-2', [citation({ versionId: 41 })])];
    const { sql } = fakeSql(items);
    const r = await cascadeFactChange(sql, supersession(), { now: NOW });
    expect(r.flagged.map((i) => i.id)).toEqual(['WI-1']);
    expect(readAssumptionFlags(items[0].payload)[0]).toMatchObject({ condition: 'superseded', supersededBy: 43 });
  });

  it('ignores items that are not terminal (a reopened item is live work, not a close)', async () => {
    const items = [item('WI-1', [citation()], { status: 'wip' })];
    const { sql } = fakeSql(items);
    const r = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(r.matched).toBe(0);
    expect(readAssumptionFlags(items[0].payload)).toEqual([]);
  });

  it('never throws: a failed read is reported and logged, not raised', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sql } = fakeSql([], { failSelect: true });
      const r = await cascadeFactChange(sql, retraction(), { now: NOW });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/does not exist/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[retraction-cascade] retracted harness:papercusp:release-window@42 failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('runs inside a savepoint when handed a transaction', async () => {
    const items = [item('WI-1', [citation()])];
    const { sql } = fakeSql(items);
    const savepoint = vi.fn(async (fn: (s: Sql) => Promise<unknown>) => fn(sql));
    (sql as unknown as { savepoint: typeof savepoint }).savepoint = savepoint;
    const r = await cascadeFactChange(sql, retraction(), { now: NOW });
    expect(savepoint).toHaveBeenCalledTimes(1);
    expect(r.flagged).toHaveLength(1);
  });
});

describe('supersessionChangedBody', () => {
  it('an unchanged body is a refresh, not a supersession', async () => {
    const { sql } = fakeSql([], { bodies: { 42: 'Friday 18:00 UTC' } });
    expect(await supersessionChangedBody(sql, 42, 'Friday 18:00 UTC')).toBe(false);
    expect(await supersessionChangedBody(sql, 42, 'Saturday 18:00 UTC')).toBe(true);
  });

  it('an unreadable prior version counts as changed (flag rather than miss)', async () => {
    const { sql } = fakeSql([], { bodies: {} });
    expect(await supersessionChangedBody(sql, 99, 'x')).toBe(true);
  });
});

describe('renderCascadeNotice', () => {
  it('says the items were NOT reopened and where the flag is read', () => {
    const { body } = renderCascadeNotice(retraction(), [
      { id: 'WI-1', harness: 'papercusp', title: 't', status: 'done', recipient: 'su-closer' },
    ]);
    expect(body).toContain('NOT reopened');
    expect(body).toContain('assumptionFlags');
  });
});
