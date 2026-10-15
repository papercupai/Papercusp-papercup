/** P-003: actual shared history/desktop reader, mocked only at DB and native-file seams. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({
  allowed: true,
  grants: null as Record<string, boolean> | null,
  authorityError: false,
  roster: {} as Record<string, unknown>,
  sql: vi.fn(),
  path: null as string | null,
  ticks: [] as Array<() => void>,
  stop: vi.fn(),
  resolveError: null as Error | null,
}));
vi.mock('@papercusp/agent-mcp', async original => ({
  ...(await original<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
}));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../../../owner-sessions/roster', () => ({ readSessionRosterSnapshot: vi.fn(async () => fixture.roster) }));
vi.mock('../../../device-store', () => ({
  deviceAgentSessionsAllowed: vi.fn(async (deviceId: string) => {
    if (fixture.authorityError) throw new Error('authority DB down');
    return fixture.grants ? fixture.grants[deviceId] === true : fixture.allowed;
  }),
  setDeviceAgentSessionsEnabled: vi.fn(async (deviceId, _workspace, enabled) => {
    if (fixture.grants) fixture.grants[deviceId] = enabled;
    else fixture.allowed = enabled;
    return true;
  }),
}));
vi.mock('../../../claude-sessions', () => ({
  resolveInteractiveTranscript: vi.fn(async () => { if (fixture.resolveError) throw fixture.resolveError; return fixture.path; }), SESSION_THINKING_ACTIVE_MS: 5000,
}));
vi.mock('../../../session-transcript-resolvers', () => ({
  findCodexRolloutPath: vi.fn(async () => fixture.path),
  findCodexRolloutPathByUuid: vi.fn(async () => fixture.path),
  findOmpSessionPath: vi.fn(async () => fixture.path),
}));
vi.mock('@papercusp/scheduled-registry', () => ({
  managedSetInterval: vi.fn((_name, _interval, tick) => { fixture.ticks.push(tick); return { stop: fixture.stop }; }),
}));

import routes, { deviceSessionTimelineQuery } from './session-transcript';
import { readOwnerSessionTimeline, projectDeviceTimelineEntry } from '../../../owner-sessions/timeline';
import { changeDeviceSessionGrant } from '../../../owner-sessions/device-authority';
import { isPhoneDevicePath } from '../../../device-ingress-paths';

const WS = 'device-workspace';
const OWNER = 'su-device-target';
const context = {
  principal: { kind: 'device', slug: 'phone-a', workspaceId: WS }, params: { owner: OWNER },
};
type Handler = (req: Request, ctx: typeof context) => Promise<Response>;
const handler = (routes[0] as unknown as { handler: Handler }).handler;
const entry = (over: Record<string, unknown> = {}) => ({
  ownerId: OWNER, label: 'Agent', role: 'su', workspaceId: WS,
  sessionState: 'live', intent: 'Ship feature', nativeSession: null,
  sessionId: 'native-session', advSessionId: null, ...over,
});
let directory: string;
const controllers: AbortController[] = [];

function history(count: number, owner = OWNER) {
  const rows = Array.from({ length: count }, (_, index) => ({
    owner, event_at: new Date(Date.UTC(2026, 9, 13, 0, index)).toISOString(),
    source_kind: 'codex', session_id: 's-1', turn_idx: index,
    speaker: index % 2 ? 'assistant' : 'user', text: `turn ${index}`,
  }));
  fixture.sql.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const cap = Number(values.at(-1));
    const cursorAt = values[2] as string | null;
    return rows.filter(row => row.owner === values[1] && (!cursorAt || row.event_at < cursorAt)).slice(-cap);
  });
  return rows;
}

async function page(query = '', owner = OWNER) {
  const response = await handler(new Request(`http://localhost/api/device/sessions/${owner}/transcript${query}`), {
    ...context, params: { owner },
  });
  return { status: response.status, body: await response.json() };
}

/** Read a finite event from an open stream; the test always aborts it in cleanup. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string): Promise<string> {
  let output = '';
  const deadline = new Promise<never>((_, reject) => {
    const timeout = setTimeout(() => reject(new Error(`missing stream event ${text}`)), 2000);
    timeout.unref();
  });
  while (!output.includes(text)) {
    const chunk = await Promise.race([reader.read(), deadline]);
    if (chunk.done) break;
    output += new TextDecoder().decode(chunk.value);
  }
  return output;
}

async function openLiveStream() {
  fixture.path = join(directory, 'rollout.jsonl');
  writeFileSync(fixture.path, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'seed' } }) + '\n');
  fixture.roster = { active: [entry({ nativeSession: { backend: 'codex', rolloutId: 'rollout' }, advSessionId: 123 })], starting: [], pending: [], ended: [] };
  return openCurrentRosterStream('phone-a', OWNER);
}

async function openCurrentRosterStream(deviceId: string, owner: string) {
  const controller = new AbortController(); controllers.push(controller);
  const response = await handler(new Request(`http://localhost/api/device/sessions/${owner}/transcript?stream=1`, { signal: controller.signal }), {
    ...context, principal: { ...context.principal, slug: deviceId }, params: { owner },
  });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  await readUntil(reader, 'event: thinking');
  return reader;
}

beforeEach(() => {
  fixture.allowed = true;
  fixture.grants = null;
  fixture.authorityError = false;
  fixture.roster = { active: [entry()], starting: [], pending: [], ended: [] };
  fixture.path = null;
  fixture.resolveError = null;
  fixture.ticks = [];
  fixture.stop.mockReset();
  fixture.sql.mockReset();
  directory = mkdtempSync(join(tmpdir(), 'device-session-transcript-'));
  history(3);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  rmSync(directory, { recursive: true, force: true });
});

describe('R-2 — shared transcript pages', () => {
  it('matches the desktop condensed history for the same owner and range', async () => {
    const device = await page('?limit=200');
    const desktop = await readOwnerSessionTimeline(new Request(`http://localhost/adv/session/thinking?historyOwner=${OWNER}&historyPage=1`));
    const { ok: _ok, ...desktopPage } = await desktop.json();
    expect(device.status).toBe(200);
    expect(device.body).toEqual(desktopPage);
  });

  it('defaults to one bounded page and walks a fixed archive exactly once', async () => {
    history(121);
    fixture.roster = { active: [], starting: [], pending: [], ended: [{ id: 1, coordOwnerId: OWNER, workspaceId: WS }] };
    let cursor: string | null = null;
    const text: string[] = [];
    do {
      const result = await page(cursor ? `?cursor=${cursor}` : '');
      expect(result.status).toBe(200);
      expect(result.body.entries.length).toBeLessThanOrEqual(50);
      text.push(...result.body.entries.map((row: { text: string }) => row.text));
      cursor = result.body.cursor;
    } while (cursor);
    expect(new Set(text).size).toBe(121);
    expect(text.length).toBe(121);
    expect(text).toContain('turn 0');
  });

  it.each(['?cursor=broken', '?limit=0', '?limit=nope', '?limit=1.5'])('refuses malformed paging %s', async query => {
    expect((await page(query)).status).toBe(400);
    expect(fixture.sql).not.toHaveBeenCalled();
  });

  it('reports unavailable history instead of an empty success', async () => {
    fixture.sql.mockRejectedValue(new Error('history unavailable'));
    expect((await page()).status).toBe(503);
  });
});

describe('R-5/R-19 — device boundaries', () => {
  it('redacts credentials from stored pages and removes tool data from live projections', async () => {
    const secret = 'sk-proj-' + 'z7'.repeat(18);
    fixture.sql.mockResolvedValue([{ event_at: '2026-10-13T00:00:00Z', source_kind: 'codex', session_id: 's', turn_idx: 0, speaker: 'assistant', text: `api_key=${secret}` }]);
    const result = await page();
    expect(JSON.stringify(result.body)).not.toContain(secret);
    expect(result.body.entries[0].text).toContain('[redacted]');
    expect(projectDeviceTimelineEntry({ kind: 'tool_result', text: 'raw-output' })).toBeNull();
    expect(projectDeviceTimelineEntry({ kind: 'tool_use', toolName: 'read', toolInput: { password: secret } })).toBeNull();
    expect(projectDeviceTimelineEntry({ kind: 'text', text: 'answer', toolInput: 'raw-args', toolId: 'raw-id' })).toEqual({ kind: 'text', text: 'answer' });
  });

  it('redacts a planted credential on an older cursor page while preserving safe text', async () => {
    const secret = 'sk-proj-' + 'c7'.repeat(18);
    const rows = history(4);
    rows[0]!.text = `api_key=${secret} cursor-page-safe-text`;

    const newest = await page('?limit=2');
    expect(newest.status).toBe(200);
    expect(newest.body.entries.map((row: { text: string }) => row.text)).toEqual(['turn 2', 'turn 3']);
    expect(newest.body.cursor).toEqual(expect.any(String));

    const older = await page(`?limit=2&cursor=${encodeURIComponent(newest.body.cursor)}`);
    expect(older.status).toBe(200);
    expect(older.body.entries).toHaveLength(2);
    expect(older.body.entries[0].text).toContain('[redacted]');
    expect(older.body.entries[0].text).toContain('cursor-page-safe-text');
    expect(older.body.entries[1].text).toBe('turn 1');
    expect(JSON.stringify(older.body)).not.toContain(secret);
    expect(older.body.cursor).toBeNull();
  });

  it('refuses a leaked foreign-workspace owner before reading history', async () => {
    fixture.roster = { active: [entry({ workspaceId: 'foreign' })], starting: [], pending: [], ended: [] };
    expect((await page()).status).toBe(404);
    expect(fixture.sql).not.toHaveBeenCalled();
  });

  it.each([false, true])('fails closed on missing grant or unavailable authority (%s)', async failure => {
    fixture.allowed = false;
    fixture.authorityError = failure;
    expect((await page()).status).toBe(failure ? 503 : 403);
    expect(fixture.sql).not.toHaveBeenCalled();
  });

  it('refuses a grant revoked during the history read', async () => {
    fixture.sql.mockImplementation(async () => { fixture.allowed = false; return []; });
    expect((await page()).status).toBe(403);
  });
});

describe('R-5/R-11/R-25/R-32 — live stream', () => {
  // Keep the detectors separate so a redaction mutant cannot stand in as proof
  // that live-follow or revocation can fail.
  it('delivers a new native turn on the already-open stream', async () => {
    const reader = await openLiveStream();
    appendFileSync(fixture.path!, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new-live-turn' } }) + '\n');
    fixture.ticks[0]!();
    expect(await readUntil(reader, 'new-live-turn')).toContain('new-live-turn');
  });

  it('redacts seeded secrets and drops raw tool arguments and output from live appends', async () => {
    const reader = await openLiveStream();
    const secret = 'sk-proj-' + 'b9'.repeat(18);
    appendFileSync(fixture.path!, [
      { type: 'response_item', payload: { type: 'function_call', name: 'read', arguments: JSON.stringify({ api_key: secret, value: 'private-tool-args' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', output: `private-tool-output ${secret}` } },
      { type: 'event_msg', payload: { type: 'agent_message', message: `token=${secret} final-safe-text` } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    await new Promise(resolve => setImmediate(resolve));
    fixture.ticks[0]!();
    const redacted = await readUntil(reader, 'final-safe-text');
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('private-tool-args');
    expect(redacted).not.toContain('private-tool-output');
    expect(redacted).toContain('[redacted]');
  });

  it('closes an operating stream immediately on grant revocation', async () => {
    const reader = await openLiveStream();
    appendFileSync(fixture.path!, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'before-revoke' } }) + '\n');
    fixture.ticks[0]!();
    expect(await readUntil(reader, 'before-revoke')).toContain('before-revoke');
    await changeDeviceSessionGrant('phone-a', WS, false);
    expect(await readUntil(reader, 'access_revoked')).toContain('access_revoked');
    expect(fixture.stop).toHaveBeenCalled();
    expect((await reader.read()).done).toBe(true);
  });

  it('revokes every open session stream for one device while another device keeps following', async () => {
    fixture.grants = { 'phone-a': true, 'phone-b': true };
    fixture.path = join(directory, 'multi-session-rollout.jsonl');
    writeFileSync(fixture.path, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'seed' } }) + '\n');
    const secondOwner = 'su-second-target';
    fixture.roster = { active: [OWNER, secondOwner].map((ownerId, index) => entry({
      ownerId, nativeSession: { backend: 'codex', rolloutId: `rollout-${index}` }, advSessionId: 123 + index,
    })), starting: [], pending: [], ended: [] };
    const first = await openCurrentRosterStream('phone-a', OWNER);
    const second = await openCurrentRosterStream('phone-a', secondOwner);
    const control = await openCurrentRosterStream('phone-b', OWNER);
    expect(fixture.ticks).toHaveLength(3);
    appendFileSync(fixture.path, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'before-multi-revoke' } }) + '\n');
    for (const tick of fixture.ticks) tick();
    for (const reader of [first, second, control]) {
      expect(await readUntil(reader, 'before-multi-revoke')).toContain('before-multi-revoke');
    }
    await changeDeviceSessionGrant('phone-a', WS, false);
    for (const reader of [first, second]) {
      expect(await readUntil(reader, 'access_revoked')).toContain('access_revoked');
      expect((await reader.read()).done).toBe(true);
    }
    expect(fixture.stop).toHaveBeenCalledTimes(2);
    appendFileSync(fixture.path, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'after-multi-revoke' } }) + '\n');
    fixture.ticks[2]!();
    const continued = await readUntil(control, 'after-multi-revoke');
    expect(continued).toContain('after-multi-revoke');
    expect(continued).not.toContain('access_revoked');
    for (const reader of [first, second]) expect((await reader.read()).done).toBe(true);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });

  it('sanitizes setup errors before sending them across the device stream', async () => {
    const secret = 'sk-proj-' + 'p3'.repeat(18);
    fixture.resolveError = new Error(`credential ${secret} in private native path`);
    const response = await handler(new Request(`http://localhost/api/device/sessions/${OWNER}/transcript?stream=1`), context);
    const wire = await response.text();
    expect(wire).toContain('transcript_unavailable');
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain('private native path');
  });

  it('opens an ended archive without requiring an on-disk native file', async () => {
    fixture.roster = { active: [], starting: [], pending: [], ended: [{ id: 1, coordOwnerId: OWNER, workspaceId: WS }] };
    const response = await handler(new Request(`http://localhost/api/device/sessions/${OWNER}/transcript?stream=1`), context);
    const wire = await response.text();
    expect(wire).toContain('turn 0');
    expect(wire).toContain('event: done');
    expect(fixture.ticks).toHaveLength(0);
  });

  it('uses canonical backend handles without letting the caller select a transcript file', async () => {
    fixture.roster = { active: [entry({ nativeSession: { backend: 'codex', rolloutId: 'rollout' }, advSessionId: 123 })], starting: [], pending: [], ended: [] };
    const query = await deviceSessionTimelineQuery(WS, OWNER);
    expect(query.get('codexSessionKey')).toBe('123');
    expect(query.get('sessionId')).toBeNull();
    expect(isPhoneDevicePath(`/api/device/sessions/${OWNER}/transcript`)).toBe(true);
    expect(isPhoneDevicePath('/api/device/sessions/../transcript')).toBe(false);
  });
});
