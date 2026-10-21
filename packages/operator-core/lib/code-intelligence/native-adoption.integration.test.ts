/**
 * P-033 / R-30 + R-31 integration layer (native-code-intelligence-ecosystem-and-dream-2026-10-09).
 *
 * Drives the REAL reader (`readNativeAdoptionWindow`, the two-step tool_invocations read plus
 * the agent_activity shell/follow-through reads) against the fully migrated schema, then the
 * REAL scorecards resolver seam that turns the measurement into platform-computed instrument
 * snapshots for the R-30 (measured) and R-31 (good use) criteria.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  NATIVE_ADOPTION_INSTRUMENT_KEYS,
  measureNativeAdoptionWindow,
  rateNativeAdoption,
  readNativeAdoptionWindow,
  readNativePushOutcomes,
  summarizeNativePushOutcomes,
  measureNativePushOutcomesWindow, NATIVE_PUSH_INSTRUMENT_KEYS,
} from './native-adoption';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import type { Rubric } from '../rubrics';

const WS = `test-native-adoption-${process.pid}`;
const OTHER_WS = `${WS}-other`;
const START = '2026-10-01T00:00:00.000Z';
const END = '2026-10-04T00:00:00.000Z';
const t = (iso: string) => new Date(iso);

let db: OrgTestDb | undefined;

async function seed(sql: OrgTestDb['adminSql']): Promise<void> {
  const invocation = (over: {
    workspace?: string; tool: string; owner: string; at: string; status?: string; errorCode?: string | null;
    role?: string; durationMs?: number | null;
  }) => ({
    workspace_id: over.workspace ?? WS, harness_slug: 'papercusp', plugin_name: 'papercusp',
    tool_name: over.tool, role: over.role ?? 'operator', spawn_id: `spawn-${over.owner}`, window_key: 'w',
    status: over.status ?? 'ok', error_code: over.errorCode ?? null, duration_ms: over.durationMs ?? null,
    invoked_at: t(over.at), coord_owner_id: over.owner,
  });
  const rows = [
    invocation({ tool: 'graph:query', owner: 'A', at: '2026-10-02T10:00:00.000Z', durationMs: 120 }),
    invocation({ tool: 'lsp:query', owner: 'A', at: '2026-10-02T11:00:00.000Z', durationMs: 80 }),
    invocation({ tool: 'lsp:query', owner: 'B', at: '2026-10-02T12:00:00.000Z', role: 'judge',
      status: 'role-not-allowed', errorCode: 'missing_capability' }),
    invocation({ tool: 'code:pack', owner: 'C', at: '2026-10-02T13:00:00.000Z', durationMs: 900 }),
    invocation({ tool: 'gitnexus.context', owner: 'D', at: '2026-10-02T14:00:00.000Z' }),
    invocation({ tool: 'coord:send', owner: 'A', at: '2026-10-02T15:00:00.000Z' }),
    // outside the window, and another workspace: both must be excluded.
    invocation({ tool: 'graph:query', owner: 'A', at: '2026-10-05T00:00:00.000Z' }),
    invocation({ workspace: OTHER_WS, tool: 'graph:query', owner: 'X', at: '2026-10-02T10:00:00.000Z' }),
  ];
  await sql`INSERT INTO harness_shared.tool_invocations ${sql(rows)}`;

  const activity = (over: { owner: string; tool: string; at: string; detail: Record<string, unknown>; workspace?: string }) => ({
    workspace_id: over.workspace ?? WS, owner_id: over.owner, kind: 'tool', tool_name: over.tool, phase: 'post',
    detail: sql.json(over.detail as never), created_at: t(over.at),
  });
  const acts = [
    // follow-through: A edits a file 5 min after graph:query; nothing after A's lsp:query; C reads after 30 min (too late).
    activity({ owner: 'A', tool: 'Edit', at: '2026-10-02T10:05:00.000Z', detail: { file: '/repo/a.ts' } }),
    activity({ owner: 'C', tool: 'Read', at: '2026-10-02T13:30:00.000Z', detail: { file: '/repo/c.ts' } }),
    // raw-text lookups
    activity({ owner: 'E', tool: 'Bash', at: '2026-10-02T09:00:00.000Z',
      detail: { command: 'grep -rn "export function rateNativeAdoption" packages/operator-core/lib' } }),
    activity({ owner: 'E', tool: 'mcp__papercusp-su__capability_bash', at: '2026-10-02T09:10:00.000Z',
      detail: { cmd: 'cd /repo || exit 1; rg -n "rateNativeAdoption(" packages' } }),
    activity({ owner: 'F', tool: 'Bash', at: '2026-10-02T09:20:00.000Z', detail: { command: 'grep -n ERROR /var/log/syslog' } }),
    activity({ owner: 'B', tool: 'Bash', at: '2026-10-02T09:30:00.000Z',
      detail: { command: "rg -n 'interface RubricCriterion' packages" } }),
    // pre-phase rows and other workspaces never count
    { ...activity({ owner: 'G', tool: 'Bash', at: '2026-10-02T09:40:00.000Z',
      detail: { command: 'grep -rn "class Foo" src' } }), phase: 'pre' },
    activity({ workspace: OTHER_WS, owner: 'H', tool: 'Bash', at: '2026-10-02T09:50:00.000Z',
      detail: { command: 'grep -rn "class Foo" src' } }),
  ];
  await sql`INSERT INTO harness_shared.agent_activity ${sql(acts)}`;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  await seed(db.adminSql);
  await seedPushOutcomes(db.adminSql);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
}, 30_000);

describe('readNativeAdoptionWindow (real ledgers)', () => {
  it('reads only in-window, in-workspace code-intelligence invocations, with the follow-through proxy', async () => {
    const read = await readNativeAdoptionWindow({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
    const byTool = read.invocations.map((row) => `${row.toolName}:${row.ownerId}:${String(row.followedThrough)}`).sort();
    expect(byTool).toEqual([
      'code:pack:C:false',
      'gitnexus.context:D:null',
      'graph:query:A:true',
      'lsp:query:A:false',
      'lsp:query:B:null',
    ]);
  });

  it('returns post-phase, in-workspace shell commands for classification', async () => {
    const read = await readNativeAdoptionWindow({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
    expect(read.shellCommands.map((row) => row.ownerId).sort()).toEqual(['B', 'E', 'E']);
  });

  it('refuses an invalid window instead of reading an unbounded range', async () => {
    await expect(readNativeAdoptionWindow({ workspaceId: WS, windowStart: END, windowEnd: START }, db!.adminSql))
      .rejects.toThrow(/valid/);
  });
});

async function seedPushOutcomes(sql: OrgTestDb['adminSql']): Promise<void> {
  const userAt = '2026-10-02T11:00:00Z';
  const pushAt = '2026-10-02T12:00:00Z';
  const endAt = '2026-10-02T13:00:00Z';
  const activityAt = '2026-10-02T12:10:00Z';
  const prompt = async (owner: string, session = owner, at = userAt, idx = 0) => {
    await sql`INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
      VALUES (${WS}, 'codex', ${session}, ${idx}, ${at}::timestamptz, ${owner}, 'user', 'fixture request')`;
    await sql`INSERT INTO harness_shared.agent_activity
      (workspace_id, owner_id, session_id, kind, tool_name, phase, status, detail, created_at)
      VALUES (${WS}, ${owner}, ${session}, 'tool', 'Read', 'post', 'ok', '{"file":"src/trigger.ts"}'::jsonb, ${at}::timestamptz)`;
  };
  const journal = async (owner: string, session = owner, at = endAt) => {
    await sql`INSERT INTO harness_shared.session_turn_journal
      (workspace_id, owner_id, source_kind, session_id, turn_ts, note, source)
      VALUES (${WS}, ${owner}, 'codex', ${session}, ${at}::timestamptz, 'fixture completion, not outcome evidence', 'mechanical')`;
  };
  const push = async (owner: string, suggested: string | null = null, workspace = WS, at = pushAt) => {
    await sql`INSERT INTO harness_shared.code_intel_pushes
      (workspace_id, owner_id, turn_id, leg, subject, cited_paths, suggested_call, chars, pushed_at)
      VALUES (${workspace}, ${owner}, ${owner}, 'grep', ${owner.replace(/-/g, '_')}, ${['src/foo.ts']}::text[], ${suggested}, 10, ${at}::timestamptz)`;
  };
  const activity = async (owner: string, detail: Record<string, unknown>, over: {
    session?: string; workspace?: string; phase?: string; status?: string; tool?: string; at?: string;
  } = {}) => {
    await sql`INSERT INTO harness_shared.agent_activity
      (workspace_id, owner_id, session_id, kind, tool_name, phase, status, detail, created_at)
      VALUES (${over.workspace ?? WS}, ${owner}, ${over.session ?? owner}, 'tool', ${over.tool ?? 'Read'},
        ${over.phase ?? 'post'}, ${over.status ?? 'ok'}, ${sql.json(detail as never)}, ${over.at ?? activityAt}::timestamptz)`;
  };
  const closed = async (owner: string) => { await prompt(owner); await push(owner); await journal(owner); };
  await closed('push-hit');
  await activity('push-hit', { file: 'src/foo.ts' });
  await activity('push-hit', { command: 'rg -n "push_hit" src' }, { tool: 'Bash' });
  await closed('push-miss');
  await activity('push-miss', { file: 'src/other.ts' });
  await prompt('push-open'); await push('push-open');
  await push('push-foreign', null, OTHER_WS);
  await push('push-at-end', null, WS, END);
  await prompt('push-at-start', 'push-at-start', '2026-09-30T23:00:00Z');
  await push('push-at-start', null, WS, START);
  await journal('push-at-start', 'push-at-start', '2026-10-01T00:30:00Z');
  await activity('push-at-start', { file: 'src/foo.ts' }, { at: '2026-10-01T00:10:00Z' });
  await closed('push-ambiguous');
  await prompt('push-ambiguous', 'another-native'); await journal('push-ambiguous', 'another-native');
  await closed('push-intervening');
  await prompt('push-intervening', 'push-intervening', '2026-10-02T12:20:00Z', 1);
  await closed('push-prior-end');
  await journal('push-prior-end', 'push-prior-end', '2026-10-02T11:30:00Z');
  await closed('push-other-session');
  await activity('push-other-session', { file: 'src/foo.ts' }, { session: 'unmatched-native' });
  await closed('push-scope');
  await activity('push-scope', { file: 'src/foo.ts' }, { workspace: OTHER_WS });
  await activity('unrelated-owner', { file: 'src/foo.ts' }, { session: 'push-scope' });
  await activity('push-scope', { file: 'src/foo.ts' }, { phase: 'pre' });
  await activity('push-scope', { file: 'src/foo.ts' }, { status: 'error' });
  await activity('push-scope', { file: 'src/foo.ts' }, { at: '2026-10-02T13:01:00Z' });
  for (const owner of ['push-test-pass', 'push-test-fail', 'push-test-request', 'push-test-foreign']) {
    await prompt(owner); await journal(owner);
    await push(owner, 'testing:run {"files":["src/foo.test.ts"]}');
    const runGroup = `group-${owner}`;
    await sql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
       coord_owner_id, invoked_at, metadata_json)
      VALUES (${WS}, 'papercusp', 'papercusp', 'testing:run', 'operator', ${owner}, 'w', 'ok',
        ${owner}, '2026-10-02T12:05:00Z', ${sql.json({ testingRun: { runId: runGroup } })})`;
    if (owner === 'push-test-request') continue;
    await sql`INSERT INTO harness_shared.test_runs
      (workspace_id, file_path, framework, status, started_at, finished_at, run_group_id)
      VALUES (${owner === 'push-test-foreign' ? OTHER_WS : WS}, 'src/foo.test.ts', 'vitest',
        ${owner === 'push-test-fail' ? 'fail' : 'pass'}, '2026-10-02T12:06:00Z', '2026-10-02T12:09:00Z', ${runGroup})`;
  }
}

describe('P-041 historical push outcomes (real ledgers)', () => {
  const read = () => readNativePushOutcomes({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
  it('counts only exact workspace/[start,end) pushes and correlated completed native turns', async () => {
    const rows = await read();
    const bySubject = await db!.adminSql<{ id: string; subject: string }[]>`
      SELECT id::text, owner_id AS subject FROM harness_shared.code_intel_pushes WHERE workspace_id = ${WS}`;
    const byOwner = Object.fromEntries(bySubject.map(p => [p.subject, rows.find(r => r.id === p.id)]));
    expect(byOwner['push-hit']).toMatchObject({ windowComplete: true, actedOn: true, grepAfterPush: true });
    expect(byOwner['push-miss']).toMatchObject({ windowComplete: true, actedOn: false, grepAfterPush: false });
    expect(byOwner['push-at-start']).toMatchObject({ windowComplete: true, actedOn: true });
    expect(byOwner['push-at-end']).toBeUndefined();
    expect(rows).toHaveLength(13);
    for (const owner of ['push-open', 'push-ambiguous', 'push-intervening', 'push-prior-end', 'push-other-session']) {
      expect(byOwner[owner]).toMatchObject({ windowComplete: false, actedOn: null, grepAfterPush: null });
    }
    expect(byOwner['push-scope']).toMatchObject({ windowComplete: true, actedOn: null, grepAfterPush: null });
  });

  it('requires completed execution rows linked to the correct workspace and invocation group', async () => {
    const rows = await read();
    const subjects = await db!.adminSql<{ id: string; subject: string }[]>`
      SELECT id::text, owner_id AS subject FROM harness_shared.code_intel_pushes WHERE workspace_id = ${WS}`;
    const outcome = (owner: string) => rows.find(r => r.id === subjects.find(p => p.subject === owner)?.id);
    expect(outcome('push-test-pass')?.actedOn).toBe(true);
    expect(outcome('push-test-fail')?.actedOn).toBe(true);
    expect(outcome('push-test-request')?.actedOn).toBeNull();
    expect(outcome('push-test-foreign')?.actedOn).toBeNull();
    const summary = summarizeNativePushOutcomes({ window: { workspaceId: WS, windowStart: START, windowEnd: END }, rows });
    expect(summary.byLeg.grep?.actedOn).toEqual({ measured: 5, positive: 4, rate: 0.8 });
  });

  it('refuses unbounded windows and does not treat absent history as a successful measurement', async () => {
    await expect(readNativePushOutcomes({ workspaceId: WS, windowStart: END, windowEnd: START }, db!.adminSql)).rejects.toThrow(/valid/);
    expect(await readNativePushOutcomes({ workspaceId: `${WS}-empty`, windowStart: START, windowEnd: END }, db!.adminSql)).toEqual([]);
  });

  it('resolves the three platform snapshots from one real ledger read without changing D-011', async () => {
    const rubric = { ref: 'push-outcome-test', workspaceId: WS, criteria: Object.values(NATIVE_PUSH_INSTRUMENT_KEYS)
      .map(key => ({ key, check: { kind: 'instrument', instrumentKey: key } })) } as unknown as Rubric;
    let reads = 0;
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric,
      subject: { kind: 'plan', ref: 'native-plan', windowStart: START, windowEnd: END } as never }, {
      now: () => Date.parse('2026-10-10T00:00:00Z'),
      nativePushOutcomes: async window => { reads += 1; return measureNativePushOutcomesWindow(window, db!.adminSql); },
    });
    expect(reads).toBe(1);
    expect(snapshots?.[NATIVE_PUSH_INSTRUMENT_KEYS.issued]).toMatchObject({ verdict: 'pass', provenance: 'platform-computed' });
    expect((snapshots?.[NATIVE_PUSH_INSTRUMENT_KEYS.actedOn]?.value as { byLeg: unknown }).byLeg).toMatchObject({ grep: { issued: 13, actedOn: { measured: 5, positive: 4, rate: 0.8 } } });
  });

  it('keeps open windows, absent evidence and read errors unknown through the resolver seam', async () => {
    const rubric = { ref: 'push-outcome-test', workspaceId: WS, criteria: Object.values(NATIVE_PUSH_INSTRUMENT_KEYS)
      .map(key => ({ key, check: { kind: 'instrument', instrumentKey: key } })) } as unknown as Rubric;
    const subject = { kind: 'plan', ref: 'native-plan', windowStart: START, windowEnd: END } as never;
    let reads = 0;
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, {
      now: () => Date.parse('2026-10-10T00:00:00Z'), nativePushOutcomes: async () => { reads += 1; throw new Error('unavailable'); },
    });
    expect(reads).toBe(1);
    for (const key of Object.values(NATIVE_PUSH_INSTRUMENT_KEYS)) expect(snapshots?.[key]?.verdict).toBe('unknown');
    const open = await resolveScorecardInstrumentSnapshots({ rubric, subject }, {
      now: () => Date.parse(START), nativePushOutcomes: async () => { throw new Error('must not read'); },
    });
    for (const key of Object.values(NATIVE_PUSH_INSTRUMENT_KEYS)) expect(open?.[key]?.verdict).toBe('unknown');
  });
});

describe('P-041 native transcript corpus partition', () => {
  const workspace = `${WS}-native-corpus`;
  const at = (hour: string) => `2026-10-02T${hour}:00:00Z`;

  it('correlates default-corpus prompts only through the scoped journal, owner and native session', async () => {
    const sql = db!.adminSql;
    const owners = ['native-hit', 'foreign-workspace', 'foreign-owner', 'foreign-native', 'foreign-source'];
    for (const owner of owners) {
      await sql`INSERT INTO harness_shared.code_intel_pushes
        (workspace_id, owner_id, turn_id, leg, subject, cited_paths, chars, pushed_at)
        VALUES (${workspace}, ${owner}, ${owner}, 'grep', 'native_symbol', ${['src/foo.ts']}::text[], 10, ${at('12')}::timestamptz)`;
      await sql`INSERT INTO harness_shared.session_turn_journal
        (workspace_id, owner_id, source_kind, session_id, turn_ts, note, source)
        VALUES (${workspace}, ${owner}, 'codex', ${owner}, ${at('13')}::timestamptz, 'completion', 'mechanical')`;
      // Native file ingestion writes this corpus partition, independently of the tenant ledgers.
      await sql`INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
        VALUES (${owner === 'foreign-workspace' ? OTHER_WS : 'default'},
          ${owner === 'foreign-source' ? 'claude' : 'codex'},
          ${owner === 'foreign-native' ? `${owner}-other` : owner}, 0, ${at('11')}::timestamptz,
          ${owner === 'foreign-owner' ? `${owner}-other` : owner}, 'user', 'native request')`;
      for (const [time, tool, detail] of [
        [at('11'), 'Read', { file: 'src/trigger.ts' }],
        ['2026-10-02T12:10:00Z', 'Read', { file: 'src/foo.ts' }],
        ['2026-10-02T12:11:00Z', 'Bash', { command: 'rg -n "native_symbol" src' }],
      ] as const) {
        await sql`INSERT INTO harness_shared.agent_activity
          (workspace_id, owner_id, session_id, kind, tool_name, phase, status, detail, created_at)
          VALUES (${workspace}, ${owner}, ${owner}, 'tool', ${tool}, 'post', 'ok',
            ${sql.json(detail as never)}, ${time}::timestamptz)`;
      }
    }
    const rows = await readNativePushOutcomes({ workspaceId: workspace, windowStart: START, windowEnd: END }, sql);
    const pushes = await sql<{ id: string; owner_id: string }[]>`
      SELECT id::text, owner_id FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace}`;
    const outcome = (owner: string) => rows.find(row => row.id === pushes.find(push => push.owner_id === owner)?.id);
    expect(outcome('native-hit')).toMatchObject({ windowComplete: true, actedOn: true, grepAfterPush: true });
    for (const owner of owners.slice(1)) {
      expect(outcome(owner)).toMatchObject({ windowComplete: false, actedOn: null, grepAfterPush: null });
    }
  });

  it('carries the activity harness so an absolute native path resolves under its exact registered root', async () => {
    const sql = db!.adminSql;
    const owner = 'native-absolute';
    await sql`INSERT INTO harness_shared.code_intel_pushes
      (workspace_id, owner_id, turn_id, leg, subject, cited_paths, chars, pushed_at)
      VALUES (${workspace}, ${owner}, ${owner}, 'first-touch', 'src/foo.ts', ${['src/foo.ts']}::text[], 10, ${at('12')}::timestamptz)`;
    await sql`INSERT INTO harness_shared.session_turn_journal
      (workspace_id, owner_id, source_kind, session_id, turn_ts, note, source)
      VALUES (${workspace}, ${owner}, 'claude', ${owner}, ${at('13')}::timestamptz, 'completion', 'mechanical')`;
    await sql`INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
      VALUES ('default', 'claude', ${owner}, 0, ${at('11')}::timestamptz, ${owner}, 'user', 'native request')`;
    for (const [time, tool, detail] of [
      [at('11'), 'Read', { file: '/repo/papercusp/src/trigger.ts' }],
      ['2026-10-02T12:10:00Z', 'mcp__papercusp_su__capability_read', { uri: 'papercusp://scratch/ws/page.spill' }],
      ['2026-10-02T12:11:00Z', 'Read', { file: '/repo/papercusp/src/foo.ts' }],
    ] as const) {
      await sql`INSERT INTO harness_shared.agent_activity
        (workspace_id, owner_id, session_id, harness_slug, kind, tool_name, phase, status, detail, created_at)
        VALUES (${workspace}, ${owner}, ${owner}, 'papercusp', 'tool', ${tool}, 'post', 'ok',
          ${sql.json(detail as never)}, ${time}::timestamptz)`;
    }
    const seen: string[][] = [];
    const resolver = async (slugs: readonly string[], ws: string) => {
      seen.push([ws, ...slugs]);
      return new Map(slugs.includes('papercusp') ? [['papercusp', '/repo/papercusp']] : []);
    };
    const rows = await readNativePushOutcomes({ workspaceId: workspace, windowStart: START, windowEnd: END }, sql, resolver);
    const [push] = await sql<{ id: string }[]>`
      SELECT id::text FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    expect(rows.find(row => row.id === push?.id)).toMatchObject({ windowComplete: true, actedOn: true, grepAfterPush: null });
    expect(seen.some(([ws, ...slugs]) => ws === workspace && slugs.includes('papercusp'))).toBe(true);
    // Without a resolvable root the same absolute evidence stays unknown, never negative.
    const unresolved = await readNativePushOutcomes({ workspaceId: workspace, windowStart: START, windowEnd: END }, sql,
      async () => new Map());
    expect(unresolved.find(row => row.id === push?.id)).toMatchObject({ windowComplete: true, actedOn: null });
  });

  it('rejects an intervening default-corpus prompt even when the preceding prompt is tenant-scoped', async () => {
    const sql = db!.adminSql;
    const owner = 'native-intervening';
    await sql`INSERT INTO harness_shared.code_intel_pushes
      (workspace_id, owner_id, turn_id, leg, subject, cited_paths, chars, pushed_at)
      VALUES (${workspace}, ${owner}, ${owner}, 'grep', 'native_symbol', ${['src/foo.ts']}::text[], 10, ${at('12')}::timestamptz)`;
    await sql`INSERT INTO harness_shared.session_turn_journal
      (workspace_id, owner_id, source_kind, session_id, turn_ts, note, source)
      VALUES (${workspace}, ${owner}, 'codex', ${owner}, ${at('13')}::timestamptz, 'completion', 'mechanical')`;
    for (const [corpus, time, idx] of [[workspace, at('11'), 0], ['default', '2026-10-02T12:20:00Z', 1]] as const) {
      await sql`INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
        VALUES (${corpus}, 'codex', ${owner}, ${idx}, ${time}::timestamptz, ${owner}, 'user', 'native request')`;
    }
    await sql`INSERT INTO harness_shared.agent_activity
      (workspace_id, owner_id, session_id, kind, tool_name, phase, status, detail, created_at)
      VALUES (${workspace}, ${owner}, ${owner}, 'tool', 'Read', 'post', 'ok',
        '{"file":"src/trigger.ts"}'::jsonb, ${at('11')}::timestamptz)`;
    const rows = await readNativePushOutcomes({ workspaceId: workspace, windowStart: START, windowEnd: END }, sql);
    const [push] = await sql<{ id: string }[]>`
      SELECT id::text FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    expect(rows.find(row => row.id === push?.id)).toMatchObject({ windowComplete: false, actedOn: null, grepAfterPush: null });
  });
});

describe('measureNativeAdoptionWindow → ratings (R-30 / R-31)', () => {
  it('summarizes adoption from the real ledgers', async () => {
    const metrics = await measureNativeAdoptionWindow({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
    expect(metrics.native).toMatchObject({ calls: 4, ok: 3, refused: 1, refusalsByRole: { judge: 1 } });
    expect(metrics.native.followThrough).toEqual({ measuredCalls: 3, followed: 1, rate: 1 / 3 });
    expect(metrics.substitutes.gitnexusDirect.calls).toBe(1);
    expect(metrics.substitutes.rawTextLookups).toMatchObject({ definition: 2, callSite: 1, total: 3, distinctAgents: 2 });
    // lookup agents A,B,C,D,E; native OK agents A,C.
    expect(metrics.adoption).toMatchObject({ lookupAgents: 5, nativeAgents: 2, agentAdoptionRate: 0.4, lookups: 8 });
    expect(metrics.adoption.nativeCallShare).toBeCloseTo(3 / 7, 10);

    const target = {
      decisionRef: 'test#D-001', frozenAt: START, baselineWindow: { windowStart: START, windowEnd: END },
      baseline: { agentAdoptionRate: 0.1, nativeCallShare: 0.1, refusalRate: 0.5, lookups: 100 },
      minLookups: 5, minAgentAdoptionRate: 0.3, minNativeCallShare: 0.4, maxRefusalRate: 0.3,
    };
    expect(rateNativeAdoption(metrics, target).goodUse.verdict).toBe('pass');
    expect(rateNativeAdoption(metrics, { ...target, minAgentAdoptionRate: 0.6 }).goodUse.verdict).toBe('fail');
  });

  it('reports observability limits on every real-ledger measurement, including an empty window', async () => {
    for (const window of [
      { workspaceId: WS, windowStart: START, windowEnd: END },
      { workspaceId: `${WS}-no-activity`, windowStart: START, windowEnd: END },
    ]) {
      const metrics = await measureNativeAdoptionWindow(window, db!.adminSql);
      expect(metrics.cannotObserve.length).toBeGreaterThan(0);
      expect(metrics.cannotObserve).toEqual(expect.arrayContaining([
        expect.stringContaining('agent_activity'),
        expect.stringContaining('Follow-through'),
      ]));
    }
  });

  it('resolves platform-computed scorecard snapshots for both criteria through the real seam', async () => {
    const rubric = {
      ref: 'acceptance-native-adoption-test',
      workspaceId: WS,
      criteria: [
        { key: 'r-30', check: { kind: 'instrument', instrumentKey: NATIVE_ADOPTION_INSTRUMENT_KEYS.measured } },
        { key: 'r-31', check: { kind: 'instrument', instrumentKey: NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse } },
      ],
    } as unknown as Rubric;
    let reads = 0;
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject: { kind: 'plan', ref: 'native-plan', windowStart: START, windowEnd: END } as never },
      {
        now: () => Date.parse('2026-10-10T00:00:00.000Z'),
        nativeAdoption: async (window) => {
          reads += 1;
          return measureNativeAdoptionWindow(window, db!.adminSql);
        },
      },
    );
    expect(reads).toBe(1);
    const measured = snapshots?.[NATIVE_ADOPTION_INSTRUMENT_KEYS.measured];
    expect(measured).toMatchObject({ verdict: 'pass', provenance: 'platform-computed' });
    expect((measured?.value as { adoption: { lookups: number } }).adoption.lookups).toBe(8);
    // Rated against the frozen D-011 target: 8 lookups is below its sample floor → inconclusive, never pass.
    const goodUse = snapshots?.[NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse];
    expect(goodUse).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
    expect((goodUse?.value as { unknownReason?: string }).unknownReason).toBe('insufficient-sample');
  });

  it('rates unknown (not pass) when the subject window is still open', async () => {
    const rubric = {
      ref: 'acceptance-native-adoption-test', workspaceId: WS,
      criteria: [{ key: 'r-30', check: { kind: 'instrument', instrumentKey: NATIVE_ADOPTION_INSTRUMENT_KEYS.measured } }],
    } as unknown as Rubric;
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject: { kind: 'plan', ref: 'native-plan', windowStart: START, windowEnd: END } as never },
      { now: () => Date.parse('2026-10-02T00:00:00.000Z'), nativeAdoption: async () => { throw new Error('must not read'); } },
    );
    expect(snapshots?.[NATIVE_ADOPTION_INSTRUMENT_KEYS.measured]?.verdict).toBe('unknown');
  });
});
