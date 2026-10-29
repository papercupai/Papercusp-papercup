/**
 * `sessions:read { session: 'self' }` through the real resolver chain.
 *
 * The filesystem fixture models a Codex carry-respawn: an ended predecessor
 * adv-session row sits beside the active row, whose managed CODEX_HOME holds
 * both the stale predecessor rollout and the live successor rollout. The
 * read must resolve the live successor for its response anchor while retaining
 * owner scope so indexed turns from both native sessions remain readable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => {
  const state = {
    home: '',
    advRows: [] as Array<{
      id: number;
      agent: string | null;
      session_id: string | null;
      omp_thread_id: string | null;
      ended_at: string | null;
    }>,
    advQueries: [] as string[],
  };

  const sql = vi.fn(async (...args: unknown[]) => {
    const [strings] = args;
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : String(strings);
    state.advQueries.push(text);
    if (!text.includes('FROM harness_shared.adv_sessions')) return [];

    // Model the production query rather than handing every row to the
    // resolver. If the active-row predicate regresses, the ended row below
    // becomes visible and the decoy rollout makes that mistake observable.
    const rows = text.includes('ended_at IS NULL')
      ? state.advRows.filter((row) => row.ended_at === null)
      : state.advRows;
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      session_id: row.session_id,
      omp_thread_id: row.omp_thread_id,
    }));
  });

  return { state, sql };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fixture.state.home || actual.homedir() };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-read-self-resolver', ownerLabel: 'su · resolver' })),
}));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
}));

// Keep this fixture focused on sessions:read's response anchoring and indexed
// predecessor/successor query. The resolver's live filesystem/adv-session
// discovery is exercised by the dedicated self-session suite; pin the
// resolved successor here so this read-path test stays deterministic.
vi.mock('../search/filters', () => ({
  resolveSearchFilters: vi.fn(async () => ({
    filters: { owners: ['su-read-self-resolver'] },
    selfSession: {
      sourceKind: 'codex',
      sessionId: '119f4fa9-4a09-78c0-8a35-d7e3382d1f8f',
      filePath: '/managed/sess-successor.jsonl',
    },
  })),
}));

// The real filter resolver force-tails the resolved transcript after resolving
// it. Keep that separate write-side operation out of this read-path fixture;
// the sessions:read → resolveSearchFilters → resolveSelfSession chain remains
// real, and the indexed rows below are the read surface under test.
vi.mock('../../search/session-ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../search/session-ingest')>()),
  ingestFileNow: vi.fn(async () => ({ inserted: 0 })),
}));

const readModule = await import('./read');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('sessions:read')!;

const OWNER = 'su-read-self-resolver';
const PREDECESSOR = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
const SUCCESSOR = '119f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
const ENDED_ADV_ID = 41001;
const ACTIVE_ADV_ID = 41002;

const indexedTurns = [
  {
    source_kind: 'codex',
    session_id: PREDECESSOR,
    turn_idx: 8,
    speaker: 'assistant',
    owner: OWNER,
    ts: null,
    text: 'before deterministic carry-respawn',
  },
  {
    source_kind: 'codex',
    session_id: SUCCESSOR,
    turn_idx: 0,
    speaker: 'user',
    owner: OWNER,
    ts: null,
    text: 'after deterministic carry-respawn',
  },
];

afterEach(async () => {
  if (fixture.state.home) await rm(fixture.state.home, { recursive: true, force: true });
  fixture.state.home = '';
  fixture.state.advRows = [];
  fixture.state.advQueries.length = 0;
});

async function seedFixture() {
  const home = await mkdtemp(join(tmpdir(), 'read-self-resolver-'));
  fixture.state.home = home;
  fixture.state.advRows = [
    {
      id: ENDED_ADV_ID,
      agent: 'codex',
      session_id: PREDECESSOR,
      omp_thread_id: null,
      ended_at: '2026-08-27T08:00:00.000Z',
    },
    {
      id: ACTIVE_ADV_ID,
      agent: 'codex',
      // A cold carry can leave the recorded native id stale while the managed
      // home receives the successor rollout.
      session_id: PREDECESSOR,
      omp_thread_id: null,
      ended_at: null,
    },
  ];

  const endedHome = join(home, '.papercusp', 'su-codex-homes', `session-${ENDED_ADV_ID}`);
  const activeHome = join(home, '.papercusp', 'su-codex-homes', `session-${ACTIVE_ADV_ID}`);
  const endedDay = join(endedHome, 'sessions', '2026', '08', '27');
  const activeDay = join(activeHome, 'sessions', '2026', '08', '27');
  await mkdir(endedDay, { recursive: true });
  await mkdir(activeDay, { recursive: true });

  const endedDecoy = join(endedDay, `rollout-2026-08-27T07-00-00-${PREDECESSOR}.jsonl`);
  const predecessorPath = join(activeDay, `rollout-2026-08-27T07-30-00-${PREDECESSOR}.jsonl`);
  const successorPath = join(activeDay, `rollout-2026-08-27T08-30-00-${SUCCESSOR}.jsonl`);
  await writeFile(endedDecoy, '{}\n');
  await writeFile(predecessorPath, '{}\n');
  await writeFile(successorPath, '{}\n');
  await utimes(endedDecoy, new Date(1_700_000_200_000), new Date(1_700_000_200_000));
  await utimes(predecessorPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  await utimes(successorPath, new Date(1_700_000_100_000), new Date(1_700_000_100_000));

  // The discovery pin intentionally names the predecessor; the resolver must
  // follow the newest rollout in the active managed home instead.
  const ptyDir = join(home, '.papercusp', 'psu-pty');
  await mkdir(ptyDir, { recursive: true });
  await writeFile(
    join(ptyDir, `${OWNER}.json`),
    JSON.stringify({ command: 'codex', args: ['--session-id', PREDECESSOR] }),
  );
}

function makeTx() {
  return vi.fn(async (...args: unknown[]) => {
    const [strings, ...values] = args;
    const text = Array.isArray(strings) ? (strings as string[]).join(' ? ') : String(strings);
    if (!text.includes('FROM harness_shared.session_turns')) return [];

    // Resolve each bound parameter by the placeholder that follows its column
    // in the SQL text, not by a fixed position: read.ts binds the text-window
    // params (offset/limit) ahead of the predicates, and a positional mock
    // silently read a number as the session id (0 turns, no error).
    const paramAfter = (marker: string): unknown => {
      const at = text.indexOf(marker);
      if (at < 0) return null;
      const placeholdersBefore = (text.slice(0, at).match(/\?/g) ?? []).length;
      return values[placeholdersBefore] ?? null;
    };
    const querySessionId = paramAfter('session_id = ') as string | null;
    const owners = paramAfter('owner = ANY(') as string[] | null;
    const sourceKind = paramAfter('source_kind = ') as string | null;
    const limit = Number(values[values.length - 1]);
    return indexedTurns
      .filter((row) => (!querySessionId || row.session_id === querySessionId))
      .filter((row) => (!owners || owners.includes(row.owner)))
      .filter((row) => (!sourceKind || row.source_kind === sourceKind))
      .slice(0, limit);
  });
}

describe("sessions:read session:'self' resolver integration (EI-21592931181974970)", () => {
  it('resolves the active successor while reading indexed predecessor and successor turns', async () => {
    await seedFixture();
    const tx = makeTx();

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', limit: 2, order: 'asc' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'read-self-resolver-test',
        role: 'judge',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx,
      },
      {},
    );
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const structured = dispatched.result?.structuredContent as {
      ok: boolean;
      session_id: string | null;
      session_ids?: Array<{ source_kind: string; session_id: string }>;
      note?: string;
      turn_count: number;
      turns: Array<{ ref: string; session_id?: string; text: string }>;
    };
    expect(structured).toMatchObject({
      ok: true,
      session_id: null,
      session_ids: [
        { source_kind: 'codex', session_id: PREDECESSOR },
        { source_kind: 'codex', session_id: SUCCESSOR },
      ],
      note: `resolved self → codex:${SUCCESSOR}`,
      turn_count: 2,
    });
    expect(structured.turns).toEqual([
      {
        ref: `session_turn:codex:${PREDECESSOR}:8`,
        turn_idx: 8,
        speaker: 'assistant',
        owner: OWNER,
        text: 'before deterministic carry-respawn',
      },
      {
        ref: `session_turn:codex:${SUCCESSOR}:0`,
        turn_idx: 0,
        speaker: 'user',
        owner: OWNER,
        text: 'after deterministic carry-respawn',
      },
    ]);

    expect(tx.mock.calls.some(([strings]) => String(strings).includes('owner = ANY'))).toBe(true);
  });

  it('judge rejects arbitrary session selectors before reading', async () => {
    for (const args of [{ session: 'claude:unrelated-session' }]) {
      const tx = makeTx();
      const dispatched = await dispatchProjectedTool(
        projected,
        'sessions:read',
        args,
        {
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
          workspaceId: 'default',
          runId: 'read-judge-scope-test',
          role: 'judge',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: true,
          tx,
        },
        {},
      );

      // Dispatch success means the handler ran; an argument-scope refusal is
      // returned as a tool error result rather than a dispatch-level failure.
      expect(dispatched.ok).toBe(true);
      expect(dispatched.result?.isError).toBe(true);
      const refusalText = dispatched.result?.content.find((item) => item.type === 'text');
      expect(refusalText?.type).toBe('text');
      if (refusalText?.type !== 'text') continue;
      expect(JSON.parse(refusalText.text)).toMatchObject({
        ok: false,
        error: 'judge_session_scope_only',
      });
      expect(tx).not.toHaveBeenCalled();
    }
  });

  it('judge can follow a self readMore ref while keeping the ref owner-scoped', async () => {
    await seedFixture();

    const ownTx = makeTx();
    const ownRef = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref: `session_turn:codex:${PREDECESSOR}:8`, text_offset: 5, text_limit: 12 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'read-judge-self-ref-test',
        role: 'judge',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: ownTx,
      },
      {},
    );

    expect(ownRef.ok, JSON.stringify(ownRef)).toBe(true);
    expect(ownRef.result?.structuredContent).toMatchObject({
      ok: true,
      turn_count: 1,
      turns: [{
        ref: `session_turn:codex:${PREDECESSOR}:8`,
        text_offset: 5,
        text: 'e determinis',
      }],
    });
    expect(ownTx.mock.calls.some(([strings]) => String(strings).includes('owner = ANY'))).toBe(true);

    const foreignTx = makeTx();
    const foreignRef = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref: 'session_turn:claude:unrelated-session:4' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'read-judge-foreign-ref-test',
        role: 'judge',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: foreignTx,
      },
      {},
    );

    expect(foreignRef.ok, JSON.stringify(foreignRef)).toBe(true);
    expect(foreignRef.result?.structuredContent).toMatchObject({ ok: true, turn_count: 0, turns: [] });
    expect(foreignTx.mock.calls.some(([strings]) => String(strings).includes('owner = ANY'))).toBe(true);
  });
});
