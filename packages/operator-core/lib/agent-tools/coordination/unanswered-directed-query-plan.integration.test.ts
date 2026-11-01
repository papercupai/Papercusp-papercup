/**
 * P-005 (plan papercusp-performance-audit-2026-10-12, decision D-002): the
 * unanswered-directed roster statement costs what the ASKS cost, not what the roster
 * ever wrote.
 *
 * Runs the real fetchUnansweredDirected against a fresh database carrying the shipped
 * index DDL (migrations 543, 691, 1053 and 1479), captures the exact statement it sends
 * with its bound parameters, and checks:
 *   1. old-vs-new equivalence — unanswered-directed.legacy-roster.sql, the roster_authored
 *      statement this replaced, frozen verbatim, returns identical rows on the fixture;
 *   2. access paths — no sequential scan of coord_event_log; the asks come from the
 *      partial expects-reply GIN index and threaded replies are index probes;
 *   3. cost shape — with open asks for one recipient only, the statement reads a small
 *      fraction of the coord_event_log rows the legacy statement reads (the legacy form
 *      reads every message the roster ever authored);
 *   4. the statement runs under SET LOCAL jit = off.
 * The behavioural cases (threading, goal clusters, loose replies, aliases, ack
 * ping-pong) are covered one by one in unanswered-directed.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { configureCoordLog, resetCoordLog } from './log';
import {
  fetchOpenAsks,
  fetchUnansweredDirected,
  UNANSWERED_LOOKBACK_MS,
  UNANSWERED_NEWEST_CAP,
  UNANSWERED_SENDER_CAP,
} from './unanswered-directed';
import { MACHINE_SENDER_PATTERN } from './machine-authored';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const MIGRATIONS = [
  '543-coord-event-log-msg-id-index.sql',
  '691-coord-event-log-related-msg-id-idx.sql',
  '1053-coord-event-log-unanswered-directed-idx.sql',
  '1479-coord-event-log-unanswered-directed-lookups.sql',
];
const LEGACY_SQL = readFileSync(resolve(__dirname, 'unanswered-directed.legacy-roster.sql'), 'utf8');

const WS = 'p005-plan-ws';
const ROSTER = Array.from({ length: 10 }, (_, i) => `su-p005-r${i}`);
const [R0] = ROSTER as [string];
const HISTORY_ROWS = 20_000; // half authored by the roster: 1,000 per member
const HOUR = 3_600_000;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

let db: FreshPgDb;
let traced: postgres.Sql;
const captured: { query: string; params: unknown[] }[] = [];
const nowMs = Date.now();

type Body = Record<string, unknown>;
const msg = (id: string, from: string, to: string[], hoursAgo: number, extra: Body = {}): Body => ({
  msg_id: id,
  from,
  to,
  kind: 'message',
  summary: `msg ${id}`,
  ts: new Date(nowMs - hoursAgo * HOUR).toISOString(),
  ...extra,
});
const ask = (id: string, from: string, to: string, hoursAgo: number, extra: Body = {}) =>
  msg(id, from, [to], hoursAgo, { expectsReply: true, expects: 'answer', ...extra });

/**
 * r1..r9: every ask is answered (threaded reply, a system-session alias reply, or a
 * same-goal cluster). r0: two asks stay open; the rest are cleared or excluded, one per
 * rule, so the fixture exercises each branch of the statement.
 */
function scenarioMessages(): Body[] {
  const out: Body[] = [];
  for (let i = 1; i <= 9; i++) {
    const r = `su-p005-r${i}`;
    const replier = i === 9 ? `system:fleet/${r}` : r;
    for (let k = 0; k < 2; k++) {
      out.push(ask(`ask-r${i}-${k}`, 'su-p005-a5', r, 10 - k));
      out.push(msg(`rep-r${i}-${k}`, replier, ['su-p005-a5'], 8 - k, { related_msg_id: `ask-r${i}-${k}` }));
    }
  }
  // r8 goal cluster: only the later ask is replied to; the earlier same-goal ask clears too.
  out.push(ask('ask-r8-g1', 'su-p005-a6', 'su-p005-r8', 6, { why: { goalRef: 'G-1' } }));
  out.push(ask('ask-r8-g2', 'su-p005-a6', 'su-p005-r8', 5, { why: { goalRef: 'G-1' } }));
  out.push(msg('rep-r8-g2', 'su-p005-r8', ['su-p005-a6'], 4, { related_msg_id: 'ask-r8-g2', why: { goalRef: 'G-1' } }));

  out.push(ask('ask-r0-a1-old', 'su-p005-a1', R0, 10));
  out.push(msg('rep-r0-a1-old', R0, ['su-p005-a1'], 9, { related_msg_id: 'ask-r0-a1-old' })); // threaded: cleared
  out.push(ask('ask-r0-a1-new', 'su-p005-a1', R0, 8)); // OPEN
  out.push(ask('ask-r0-a2-old', 'su-p005-a2', R0, 7)); // OPEN (one loose reply clears only the newest)
  out.push(ask('ask-r0-a2-new', 'su-p005-a2', R0, 5)); // cleared by the loose reply below
  out.push(msg('loose-r0-a2', R0, ['su-p005-a2'], 4)); // un-threaded reply back to a2
  // ack ping-pong: a plain reply to something r0 itself sent (bg-20 is authored by r0).
  out.push(msg('ack-r0', 'su-p005-a3', [R0], 3, { expectsReply: true, related_msg_id: 'bg-20' }));
  out.push(ask('ask-r0-stale', 'su-p005-a1', R0, 5 * 24)); // outside the 3-day lookback
  out.push(ask('ask-r0-machine', 'su-p005-sweep', R0, 2)); // machine-pattern sender
  out.push(ask('ask-r0-none', 'su-p005-a4', R0, 2, { expects: 'none' })); // expects:none
  return out;
}

async function seed(): Promise<void> {
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      surface text NOT NULL,
      writer_key text,
      msg_id text NOT NULL,
      body jsonb NOT NULL,
      ts timestamptz NOT NULL DEFAULT now(),
      harness_slug text
    )`);
  for (const f of MIGRATIONS) await db.sql.unsafe(readFileSync(resolve(SQL_DIR, f), 'utf8')).simple();
  // Authored history: messages between roster members and unrelated agents over ten days,
  // ~1.5 kB bodies, a third of them threaded onto an earlier message.
  await db.sql.unsafe(
    `INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
     SELECT $1, 'messages', 'bg-' || g,
            jsonb_build_object(
              'msg_id', 'bg-' || g,
              'from', CASE WHEN g % 2 = 0 THEN 'su-p005-r' || ((g / 2) % 10) ELSE 'su-p005-o' || (g % 40) END,
              'to', jsonb_build_array('su-p005-o' || (g % 40)),
              'kind', 'message',
              'summary', 'status ' || g,
              'body', repeat('lorem ipsum dolor ', 80),
              'ts', to_char((now() - (g % 240) * interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            || CASE WHEN g % 3 = 0 THEN jsonb_build_object('related_msg_id', 'bg-' || (g - 1)) ELSE '{}'::jsonb END,
            now() - (g % 240) * interval '1 hour'
       FROM generate_series(1, ${HISTORY_ROWS}) g`,
    [WS],
  );
  await db.sql.unsafe(
    `INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
     SELECT $1, 'messages', m->>'msg_id', m, (m->>'ts')::timestamptz
       FROM jsonb_array_elements(($2::text)::jsonb) m`, // text first: postgres.js re-serializes a string bound to jsonb
    [WS, JSON.stringify(scenarioMessages())],
  );
  await db.sql.unsafe('ANALYZE harness_shared.coord_event_log');
}

/** Run the real function once and return the roster statement it sent. */
async function captureRosterStatement(): Promise<{ query: string; params: unknown[]; all: string[] }> {
  captured.length = 0;
  await fetchUnansweredDirected(ROSTER, { workspaceId: WS, nowMs, endedSendersFn: async () => new Set() });
  const stmt = captured.find((c) => c.query.includes('WITH directed AS MATERIALIZED'));
  expect(stmt, 'fetchUnansweredDirected sent no roster statement').toBeDefined();
  return { ...stmt!, all: captured.map((c) => c.query.trim()) };
}

const legacyParams = (): unknown[] => {
  const since = nowMs - UNANSWERED_LOOKBACK_MS;
  return [
    WS, ROSTER, ROSTER, since, WS, ROSTER, ROSTER, [], since, MACHINE_SENDER_PATTERN,
    UNANSWERED_SENDER_CAP, UNANSWERED_SENDER_CAP, UNANSWERED_SENDER_CAP,
    UNANSWERED_NEWEST_CAP, UNANSWERED_NEWEST_CAP, UNANSWERED_NEWEST_CAP, UNANSWERED_NEWEST_CAP,
  ];
};

async function run(query: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return traced.begin(async (tx) => {
    await tx`SET LOCAL jit = off`;
    return [...(await tx.unsafe(query, params as never[]))];
  });
}

async function analyze(query: string, params: unknown[]): Promise<PlanNode[]> {
  const out = await run(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, params);
  const plan = out[0]!['QUERY PLAN'] as { Plan: PlanNode }[];
  return flatten(plan[0]!.Plan);
}

/** Heap rows a plan touched in coord_event_log: returned + filtered out, per loop. */
const coordRowsRead = (nodes: PlanNode[]): number =>
  nodes
    .filter((n) => n['Relation Name'] === 'coord_event_log')
    .reduce(
      (sum, n) =>
        sum +
        ((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) *
          (n['Actual Loops'] ?? 1),
      0,
    );

const normalize = (rows: Record<string, unknown>[]) =>
  JSON.stringify([...rows].sort((a, b) => String(a.recipient).localeCompare(String(b.recipient))));

beforeAll(async () => {
  db = await createFreshPgDb('p005-roster-plan');
  await seed();
  traced = postgres(db.url, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    debug: (_connection, query, params) => {
      captured.push({ query, params: params as unknown[] });
    },
  });
  configureCoordLog({ getSql: () => traced, getWorkspaceId: () => WS, workspaceId: WS } as never);
}, 180_000);

afterAll(async () => {
  resetCoordLog();
  await traced?.end({ timeout: 5 });
  await db?.cleanup();
});

describe('unanswered-directed roster statement (P-005)', () => {
  it('returns the same rows as the frozen legacy statement, and the fixture leaves exactly two asks open for r0', async () => {
    const stmt = await captureRosterStatement();
    const current = await run(stmt.query, stmt.params);
    const legacy = await run(LEGACY_SQL, legacyParams());

    expect(normalize(current)).toBe(normalize(legacy));
    expect(current).toHaveLength(1);
    expect(current[0]!.recipient).toBe(R0);
    expect(Number(current[0]!.cnt)).toBe(2);
    expect([...(current[0]!.newest_ids as string[])].sort()).toEqual(['ask-r0-a1-new', 'ask-r0-a2-old']);
  });

  it('counts resolved @file and @fleet-leader questions, excludes other audiences, then clears replies', async () => {
    const fileAskId = 'ask-r0-file-selector';
    const fleetLeaderAskId = 'ask-r0-fleet-leader-selector';
    const topicAskId = 'ask-r0-topic-selector';
    const broadcastAskId = 'ask-r0-wildcard';
    const extraMessages = [
      ask(fileAskId, 'su-p005-a7', R0, 0.01, {
        audience: ['@file:packages/operator-core/lib/storage/disk-reclaim.ts'],
      }),
      ask(fleetLeaderAskId, 'su-p005-a10', R0, 0.01, {
        audience: ['@fleet-leader:nonp2p-bug-drain-luna-max-0930'],
      }),
      ask(topicAskId, 'su-p005-a8', R0, 0.01, { audience: ['@topic:storage'] }),
      msg(broadcastAskId, 'su-p005-a9', ROSTER, 0.01, {
        expectsReply: true,
        expects: 'answer',
        audience: ['*'],
      }),
    ];
    const insertMessages = async (messages: Body[]) => {
      await db.sql.unsafe(
        `INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
         SELECT $1, 'messages', m->>'msg_id', m, (m->>'ts')::timestamptz
           FROM jsonb_array_elements(($2::text)::jsonb) m`,
        [WS, JSON.stringify(messages)],
      );
    };

    await insertMessages(extraMessages);
    try {
      const recipientBefore = await fetchUnansweredDirected([R0], {
        workspaceId: WS,
        nowMs,
        endedSendersFn: async () => new Set(),
      });
      const recipientSummary = recipientBefore.get(R0);
      expect(recipientSummary?.count).toBe(4);
      expect(recipientSummary?.newest.map((entry) => entry.msgId)).toContain(fileAskId);
      expect(recipientSummary?.newest.map((entry) => entry.msgId)).toContain(fleetLeaderAskId);
      expect(recipientSummary?.newest.map((entry) => entry.msgId)).not.toContain(topicAskId);
      expect(recipientSummary?.newest.map((entry) => entry.msgId)).not.toContain(broadcastAskId);

      const sendersBefore = await fetchOpenAsks(
        ['su-p005-a7', 'su-p005-a8', 'su-p005-a9', 'su-p005-a10'],
        {
        nowMs,
        recipientStatesFn: async () => new Map<string, null>(),
        },
      );
      expect(sendersBefore.get('su-p005-a7')?.count).toBe(1);
      expect(sendersBefore.get('su-p005-a7')?.newest.map((entry) => entry.msgId)).toContain(fileAskId);
      expect(sendersBefore.get('su-p005-a10')?.count).toBe(1);
      expect(sendersBefore.get('su-p005-a10')?.newest.map((entry) => entry.msgId)).toContain(
        fleetLeaderAskId,
      );
      expect(sendersBefore.has('su-p005-a8')).toBe(false);
      expect(sendersBefore.has('su-p005-a9')).toBe(false);

      await insertMessages([
        msg('reply-r0-file-selector', R0, ['su-p005-a7'], 0.005, {
          related_msg_id: fileAskId,
        }),
        msg('reply-r0-fleet-leader-selector', R0, ['su-p005-a10'], 0.005, {
          related_msg_id: fleetLeaderAskId,
        }),
      ]);

      const recipientAfter = await fetchUnansweredDirected([R0], {
        workspaceId: WS,
        nowMs,
        endedSendersFn: async () => new Set(),
      });
      expect(recipientAfter.get(R0)?.count).toBe(2);
      expect(recipientAfter.get(R0)?.newest.map((entry) => entry.msgId)).not.toContain(fileAskId);
      expect(recipientAfter.get(R0)?.newest.map((entry) => entry.msgId)).not.toContain(
        fleetLeaderAskId,
      );

      const sendersAfter = await fetchOpenAsks(['su-p005-a7'], {
        nowMs,
        recipientStatesFn: async () => new Map<string, null>(),
      });
      expect(sendersAfter.has('su-p005-a7')).toBe(false);
      const fleetLeaderSenderAfter = await fetchOpenAsks(['su-p005-a10'], {
        nowMs,
        recipientStatesFn: async () => new Map<string, null>(),
      });
      expect(fleetLeaderSenderAfter.has('su-p005-a10')).toBe(false);
    } finally {
      await db.sql.unsafe(
        'DELETE FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND msg_id = ANY($2::text[])',
        [
          WS,
          [
            fileAskId,
            fleetLeaderAskId,
            topicAskId,
            broadcastAskId,
            'reply-r0-file-selector',
            'reply-r0-fleet-leader-selector',
          ],
        ],
      );
    }
  });

  it('reads the asks through the partial GIN index, probes replies by index, and never scans the table', async () => {
    const stmt = await captureRosterStatement();
    const nodes = await analyze(stmt.query, stmt.params);
    const types = nodes.map((n) => `${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}`);

    expect(types, 'a sequential scan of coord_event_log is the cost this statement exists to avoid').not.toContain(
      'Seq Scan on coord_event_log',
    );
    const gin = nodes.filter((n) => n['Index Name'] === 'coord_event_log_msgs_to_expects_reply_gin');
    expect(gin.length, 'the asks must be read through the partial GIN index').toBeGreaterThan(0);
    // GIN allows an unqualified full-index scan, so without the `to ?| recipients`
    // predicate the planner still "uses" this index while reading every open ask in
    // the workspace. On this small fixture the row-count test cannot tell the two
    // apart (a mutation probe removing the predicate survived it), so pin the key.
    expect(
      gin.map((n) => n['Index Cond'] ?? '(none)'),
      'the GIN scan must be keyed by the recipients (?|), not a full scan of every open ask',
    ).toEqual(gin.map(() => expect.stringContaining('?|')));
    expect(nodes.some((n) => n['Index Name'] === 'coord_event_log_related_msg_id_idx')).toBe(true);
  });

  it('reads a small fraction of the rows the legacy statement reads when one recipient has open asks', async () => {
    const stmt = await captureRosterStatement();
    const currentRead = coordRowsRead(await analyze(stmt.query, stmt.params));
    const legacyRead = coordRowsRead(await analyze(LEGACY_SQL, legacyParams()));

    // The legacy form reads every message the ten roster members ever wrote.
    expect(legacyRead).toBeGreaterThanOrEqual(HISTORY_ROWS / 2);
    // The current form reads the asks, their replies, and r0's own history only.
    expect(currentRead).toBeLessThan(legacyRead / 4);
  });

  it('runs the roster statement with JIT off', async () => {
    const { all } = await captureRosterStatement();
    const set = all.findIndex((q) => /^SET LOCAL jit = off$/i.test(q));
    const roster = all.findIndex((q) => q.includes('WITH directed AS MATERIALIZED'));
    expect(set).toBeGreaterThanOrEqual(0);
    expect(set).toBeLessThan(roster);
  });

  it('falls back to scanning the table without migration 1479 (the guard can fail)', async () => {
    await db.sql.unsafe(`
      DROP INDEX harness_shared.coord_event_log_msgs_to_expects_reply_gin;
      DROP INDEX harness_shared.coord_event_log_msgs_from_system_session_idx;`).simple();
    try {
      const stmt = await captureRosterStatement();
      const nodes = await analyze(stmt.query, stmt.params);
      expect(nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'coord_event_log')).toBe(true);
    } finally {
      await db.sql.unsafe(readFileSync(resolve(SQL_DIR, MIGRATIONS[3]!), 'utf8')).simple();
    }
  });
});
