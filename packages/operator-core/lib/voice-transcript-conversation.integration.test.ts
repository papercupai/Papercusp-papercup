/**
 * Two-tier voice turns land in the conversation text chat reads (plan
 * voice-two-tier-elevenlabs-agent-2026-10-06, P-005 / SPEC-P-005, decision
 * D-008), against the real migrated schema (`baselineSchemaDsn`).
 *
 * What is real here: the desktop's two-tier transcript wiring
 * (`createTwoTierTranscript` + `routeVoiceMessageToTranscript` →
 * `persistOperatorVoiceTurn`), the operator's POST/GET
 * `/api/operator/conversations/:id/turns` handlers, `appendTurn` /
 * `listTurnsRecent` (the read behind both the GET route and the
 * `operatorTurns.page` sync query text chat renders), and Postgres. The only
 * stand-in is `fetch`: it hands the client's request straight to the real
 * route handler instead of going over a socket. The portal host posts the
 * same `{ role, text, source }` body to the same route, so the second suite
 * models the portal's server-written answer at that boundary.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { createVoiceTranscriptWriter } from '@papercusp/chat-protocol';

const WS = `ws-voice-transcript-it-${process.pid}`;

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql, db: h.db }),
  };
});
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => WS,
  resolveConcreteWorkspaceId: (value?: string) =>
    value && value.trim() && value !== '*' ? value.trim() : WS,
}));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// elevenlabs-conv's command/browser imports are only used by startElevenLabsConv
// (not under test); the same stubs as its unit test keep the module graph inert.
vi.mock('./browser-workspace', () => ({ wsLocalKey: (k: string) => k }));
vi.mock('./commands/defs', () => ({}));
vi.mock('./commands/registry', () => ({
  list: vi.fn(() => []),
  runCommand: vi.fn(async () => ({ ok: true })),
  runQuery: vi.fn(async () => ({ ok: true })),
}));

type RouteHandler = (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
const turnRoutes = (await import('./endpoint-route/routes/operator/conversation-turns'))
  .default as unknown as Array<{ method: string; handler: RouteHandler }>;
const getTurns = turnRoutes.find((r) => r.method === 'GET')!.handler;
const postTurn = turnRoutes.find((r) => r.method === 'POST')!.handler;
const { createTwoTierTranscript, routeVoiceMessageToTranscript } = await import(
  './voice-engines/elevenlabs-conv'
);

const TURNS_PATH = /^\/api\/operator\/conversations\/([^/]+)\/turns$/;

interface ReadTurn {
  seq: number;
  role: string;
  text: string;
  source: string;
  elConvId: string | null;
}

/** What text chat shows: the GET turns route, which reads `listTurnsRecent`. */
async function textChatTurns(conversationId: string): Promise<ReadTurn[]> {
  const res = await getTurns(
    new Request(`http://127.0.0.1/api/operator/conversations/${conversationId}/turns?limit=500`),
    { params: { id: conversationId } },
  );
  expect(res.status).toBe(200);
  const page = (await res.json()) as { turns: ReadTurn[] };
  return page.turns;
}

const shape = (turns: ReadTurn[]) => turns.map(({ role, source, text }) => ({ role, source, text }));

async function createConversation(): Promise<string> {
  const id = randomUUID();
  await h.sql.unsafe(
    `INSERT INTO harness_shared.operator_conversations (id, workspace_id, started_at) VALUES ($1, $2, $3)`,
    [id, WS, Date.now()],
  );
  created.push(id);
  return id;
}

const created: string[] = [];
const posted: Array<{ conversationId: string; status: number }> = [];

beforeAll(async () => {
  const dsn = inject('baselineSchemaDsn');
  await assertPgReachable(dsn, 'voice-transcript-conversation.integration');
  h.sql = postgres(dsn, { max: 4, onnotice: () => {} });
  h.db = drizzle(h.sql);
  // The client posts a relative URL; route it to the real handler.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const match = TURNS_PATH.exec(path);
    if (!match || (init?.method ?? 'GET') !== 'POST') {
      throw new Error(`unexpected fetch in voice transcript test: ${init?.method ?? 'GET'} ${path}`);
    }
    const conversationId = decodeURIComponent(match[1]!);
    const res = await postTurn(
      new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: init?.headers, body: init?.body }),
      { params: { id: conversationId } },
    );
    posted.push({ conversationId, status: res.status });
    return res;
  });
});

afterEach(() => {
  posted.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!h.sql) return;
  if (created.length > 0) {
    await h.sql.unsafe(`DELETE FROM harness_shared.operator_turns WHERE conversation_id = ANY($1::uuid[])`, [created]);
    await h.sql.unsafe(`DELETE FROM harness_shared.operator_conversations WHERE id = ANY($1::uuid[])`, [created]);
  }
  await h.sql.end({ timeout: 5 });
});

describe('desktop two-tier voice session → the conversation text chat reads (real PG)', () => {
  it('writes the user, the front agent and the brain answer once each, after the typed turns, and skips the spoken relay', async () => {
    const conversationId = await createConversation();
    // Text chat already has a typed exchange in this conversation.
    for (const body of [
      { role: 'user', text: 'Hi Papercup, I am planning the offsite.', source: 'text_typed' },
      { role: 'assistant', text: 'Happy to help with the offsite.', source: 'text_typed' },
    ]) {
      const res = await postTurn(
        new Request(`http://127.0.0.1/api/operator/conversations/${conversationId}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: { id: conversationId } },
      );
      expect(res.status).toBe(200);
    }

    const transcript = createTwoTierTranscript({ conversationId, elConvId: () => 'el-conv-it-1' });
    const answer = 'The offsite is on March 14 at the Lakeside venue, and 22 people have confirmed.';
    const route = (source: 'user' | 'ai', message: string) =>
      routeVoiceMessageToTranscript(transcript, { source, message });

    route('user', 'When is the offsite and how many people are coming?');
    route('ai', 'One moment, let me check.'); // forced pre-tool speech while ask_papercup runs
    await transcript.brainAnswered(answer); // the ask_papercup answer hook
    route('ai', `Here is what I found. ${answer}`); // the front speaking the answer aloud
    route('user', 'Great, thanks.');
    route('ai', 'You are welcome. Anything else for the offsite?');
    // Writes are serialized; once this sentinel is readable everything before it landed.
    route('user', 'No, that is all.');
    await vi.waitFor(
      async () => {
        const turns = await textChatTurns(conversationId);
        expect(turns.at(-1)?.text).toBe('No, that is all.');
      },
      { timeout: 10_000, interval: 50 },
    );

    const turns = await textChatTurns(conversationId);
    expect(shape(turns)).toEqual([
      { role: 'user', source: 'text_typed', text: 'Hi Papercup, I am planning the offsite.' },
      { role: 'assistant', source: 'text_typed', text: 'Happy to help with the offsite.' },
      { role: 'user', source: 'voice_stt', text: 'When is the offsite and how many people are coming?' },
      { role: 'assistant', source: 'voice_tts', text: 'One moment, let me check.' },
      { role: 'assistant', source: 'voice_tts', text: answer },
      { role: 'user', source: 'voice_stt', text: 'Great, thanks.' },
      { role: 'assistant', source: 'voice_tts', text: 'You are welcome. Anything else for the offsite?' },
      { role: 'user', source: 'voice_stt', text: 'No, that is all.' },
    ]);
    // One history, strictly ordered.
    expect(turns.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The answer is in the history exactly once.
    expect(turns.filter((t) => t.text.includes(answer))).toHaveLength(1);
    // Voice turns carry the ElevenLabs conversation id; typed turns do not.
    expect(turns.slice(2).every((t) => t.elConvId === 'el-conv-it-1')).toBe(true);
    expect(turns.slice(0, 2).every((t) => t.elConvId === null)).toBe(true);
    // Every voice write was accepted by the route, none dropped.
    expect(posted).toHaveLength(6);
    expect(posted.every((p) => p.status === 200 && p.conversationId === conversationId)).toBe(true);

    // The stored rows, not just the route's projection, carry the voice sources.
    const rows = await h.sql.unsafe<{ seq: number; source: string; workspace_id: string }[]>(
      `SELECT seq, source, workspace_id FROM harness_shared.operator_turns WHERE conversation_id = $1 ORDER BY seq`,
      [conversationId],
    );
    expect(rows.map((r) => r.source)).toEqual([
      'text_typed', 'text_typed', 'voice_stt', 'voice_tts', 'voice_tts', 'voice_stt', 'voice_tts', 'voice_stt',
    ]);
    expect(rows.every((r) => r.workspace_id === WS)).toBe(true);
  });

  it('a pinned conversation that no longer exists receives nothing, and no other conversation does either', async () => {
    const other = await createConversation();
    const gone = randomUUID();
    const transcript = createTwoTierTranscript({ conversationId: gone, elConvId: () => 'el-conv-it-2' });
    routeVoiceMessageToTranscript(transcript, { source: 'user', message: 'Is anyone there?' });
    await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 10_000, interval: 50 });

    expect(posted[0]).toEqual({ conversationId: gone, status: 404 });
    expect(await textChatTurns(other)).toEqual([]);
    const [count] = await h.sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM harness_shared.operator_turns WHERE el_conv_id = 'el-conv-it-2'`,
    );
    expect(count!.n).toBe(0);
  });
});

describe('portal shape: the host writes the brain answer server-side (real PG)', () => {
  it('the front repeating that answer is skipped, so the answer appears once', async () => {
    const conversationId = await createConversation();
    const postBody = async (body: { role: string; text: string; source: string }) => {
      const res = await postTurn(
        new Request(`http://127.0.0.1/api/operator/conversations/${conversationId}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: { id: conversationId } },
      );
      expect(res.status).toBe(200);
    };
    // The portal host's voice-turns route derives the source from the role.
    const writer = createVoiceTranscriptWriter({
      write: (turn) =>
        postBody({ role: turn.role, text: turn.text, source: turn.role === 'user' ? 'voice_stt' : 'voice_tts' }),
    });
    const answer = 'Your next invoice is due on April 2 for 1,200 dollars.';

    await writer.userSaid('When is my next invoice due?');
    await writer.frontSaid('Let me look that up.');
    // sendTurn with voice:true stores the answer itself; the browser only notes it.
    await postBody({ role: 'assistant', text: answer, source: 'voice_tts' });
    writer.noteBrainAnswer(answer);
    await writer.frontSaid(`${answer} Anything else?`);
    await writer.frontSaid('I can also send you a reminder the day before.');

    expect(shape(await textChatTurns(conversationId))).toEqual([
      { role: 'user', source: 'voice_stt', text: 'When is my next invoice due?' },
      { role: 'assistant', source: 'voice_tts', text: 'Let me look that up.' },
      { role: 'assistant', source: 'voice_tts', text: answer },
      { role: 'assistant', source: 'voice_tts', text: 'I can also send you a reminder the day before.' },
    ]);
  });
});
