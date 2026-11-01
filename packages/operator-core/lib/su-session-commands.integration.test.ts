import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { Hono } from 'hono';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SU_SESSION_SCHEMA, type SuSessionCommand, type SuSessionDescriptor } from '@papercusp/chat-protocol';
import type { OrgTestDb } from '../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: fixture.sql }),
}));
// Mutation-probe seam (copy-out tier): SU_SESSION_HOST_SUBJECT substitutes a mutated copy of
// su-session-host.ts for EVERY importer (this suite and the su-session route), so a caught
// mutant proves the dedupe/replay assertions are falsifiable without touching the shared tree.
vi.mock('./su-session-host', async (original) => (process.env.SU_SESSION_HOST_SUBJECT
  ? import(process.env.SU_SESSION_HOST_SUBJECT)
  : original<object>()));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { loadSuOwnerTurnReceipts, pgSuSessionCommandStore } = await import('./su-session-commands');
const { SuSessionHost, _resetSuSessionHostsForTest, registerSuSessionHost } = await import('./su-session-host');
const { persistSuSessionDescriptor, readDurableSuSession } = await import('./su-session-persistence');
const { suSessionRoutes } = await import('./endpoint-route/routes/agent-chats/su-session');
const { registerRoute } = await import('./endpoint-route/define-route');
const { runWithWorkspace } = await import('./workspace-als');
const { prepareSuSessionInput } = await import('./su-session-input');

const workspaceId = 'papercusp-workspace';
const harnessSlug = 'papercusp';
const agentChatId = 'pui-durable-command-test';
let db: OrgTestDb;
let sql: Sql;
let advSessionId: number;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  fixture.sql = sql;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });
afterEach(() => { _resetSuSessionHostsForTest(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM harness_shared.agent_chats_consolidated WHERE workspace_id = ${workspaceId}`;
  await sql`
    INSERT INTO harness_shared.agent_chats_consolidated
      (workspace_id, harness_slug, id, role, transcript, created_at, updated_at, su_runtime_class)
    VALUES (${workspaceId}, ${harnessSlug}, ${agentChatId}, 'operator', '[]'::jsonb,
            ${Date.now()}, ${Date.now()}, 'su-session')`;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, agent, coord_owner_id, su_agent_chat_id, session_id)
    VALUES (${workspaceId}, 'console', 'claude', 'su-command-fixture', ${agentChatId}, 'native-command-fixture') RETURNING id`;
  advSessionId = Number(row.id);
});

function descriptor(): SuSessionDescriptor<'claude'> {
  const supported = { state: 'supported', implementation: 'host' } as const;
  return {
    identity: { workspaceId, harnessSlug, agentChatId, advSessionId, backend: 'claude',
      ownerId: 'su-command-fixture', nativeSessionId: 'native-command-fixture' },
    lifecycle: 'ready', runtimeGeneration: 1, role: 'su', carry: 'warm',
    model: null, accountServed: null, accountRoute: 'default', modes: [],
    capabilities: {
      commands: { owner_turn: supported, interrupt: supported, resume: supported, fork: supported, focus: supported, end: supported },
      features: { 'tool-events': supported, 'interactive-cards': supported, 'reasoning-stream': supported, usage: supported, compaction: supported,
        approvals: supported, context: supported, modes: supported },
    },
    backendExtension: { backend: 'claude', configDir: null, configDirSource: 'unknown' },
  };
}

function ownerTurn(commandId = 'durable-first-turn') {
  return {
    schema: SU_SESSION_SCHEMA, protocolVersion: 1 as const, type: 'owner_turn' as const,
    commandId, issuedAt: '2026-09-07T00:00:00.000Z', target: descriptor().identity,
    turnId: `turn-${commandId}`, content: '  Exact Unicode text λ\nsecond line  ',
  };
}

async function storedTurns() {
  const [row] = await sql<{ transcript: Array<{ content: string; su_command: { command: unknown; outcome?: unknown } }> }[]>`
    SELECT transcript FROM harness_shared.agent_chats_consolidated
     WHERE workspace_id = ${workspaceId} AND id = ${agentChatId}`;
  return row.transcript;
}

describe('SU command acceptance through real PostgreSQL', () => {
  it.each((['claude', 'codex'] as const).flatMap(backend =>
    (['pty', 'programmatic'] as const).map(executionKind => ({ backend, executionKind })),
  ))(
    'SU-EXEC R-8 acceptance contract: $backend $executionKind replacement fences durable admission and replay', async ({ backend, executionKind }) => {
      await sql`UPDATE harness_shared.adv_sessions SET agent = ${backend} WHERE id = ${advSessionId}`;
      const snapshot = { ...descriptor(), executionKind,
        identity: { ...descriptor().identity, backend },
        backendExtension: backend === 'claude' ? descriptor().backendExtension : { backend, codexHome: null },
      } as SuSessionDescriptor;
      expect(await persistSuSessionDescriptor(advSessionId, snapshot, workspaceId)).toBe(true);
      const original = vi.fn(async () => ({ status: 'completed' as const }));
      const replacement = vi.fn(async () => ({ status: 'completed' as const }));
      const host = new SuSessionHost({ descriptor: snapshot, executeCommand: original });
      const durable = pgSuSessionCommandStore({ sql });
      let committed!: () => void, release!: () => void;
      const reserved = new Promise<void>((resolve) => { committed = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const store = {
        reserve: async (...args: Parameters<typeof durable.reserve>) => {
          const result = await durable.reserve(...args);
          committed();
          await released;
          return result;
        },
        finish: durable.finish,
      };
      const command = { ...ownerTurn(`${backend}-${executionKind}-reserved-before-replacement`), target: snapshot.identity };
      let restored: InstanceType<typeof SuSessionHost> | undefined;
      try {
        const pending = host.acceptCommand(command, store);
        await reserved;
        expect(original).not.toHaveBeenCalled();
        expect(host.recent.some(({ event }) => event.type === 'command_result')).toBe(false);
        host.reconcileRuntimeExit({ expected: false, exitCode: 1 });
        const next = { ...snapshot, runtimeGeneration: 2 };
        host.attachRuntime({ descriptor: next, executeCommand: replacement, runtimeReady: () => true });
        expect(await persistSuSessionDescriptor(advSessionId, next, workspaceId)).toBe(true);
        release();
        const dispatch = await pending;
        expect(dispatch.accepted).toBeNull();
        expect(await dispatch.terminal).toMatchObject({
          status: 'refused', refusal: { code: 'runtime_generation_mismatch', retryable: false },
        });
        expect(original).not.toHaveBeenCalled();
        expect(replacement).not.toHaveBeenCalled();
        expect(await storedTurns()).toMatchObject([{
          su_command: { command, outcome: { status: 'refused', refusal: { code: 'runtime_generation_mismatch' } } },
        }]);

        host.dispose();
        const record = await readDurableSuSession({ advSessionId, workspaceId });
        expect(record?.runtimeGeneration).toBe(2);
        expect(record?.descriptor?.executionKind).toBe(executionKind);
        restored = new SuSessionHost({ descriptor: record!.descriptor!, executeCommand: replacement });
        const replay = await restored.acceptCommand(command, durable);
        expect(replay.replayed).toBe(true);
        expect(await replay.terminal).toMatchObject({ refusal: { code: 'runtime_generation_mismatch' } });
        expect(replacement).not.toHaveBeenCalled();
        const fresh = await restored.acceptCommand({
          ...ownerTurn(`${backend}-current-generation`), target: snapshot.identity, expectedRuntimeGeneration: 2,
        }, durable);
        expect((await fresh.terminal).status).toBe('completed');
        expect(replacement).toHaveBeenCalledOnce();
        expect(await storedTurns()).toHaveLength(2);
      } finally { release(); host.dispose(); restored?.dispose(); }
    },
  );

  it('SU-EXEC R-6 acceptance contract: preserves usable image bytes through durable command storage and reconnect for both providers', async () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
    for (const backend of ['claude', 'codex'] as const) {
      await sql`UPDATE harness_shared.adv_sessions SET agent = ${backend} WHERE id = ${advSessionId}`;
      const snapshot = { ...descriptor(), executionKind: 'programmatic', identity: { ...descriptor().identity, backend },
        backendExtension: backend === 'claude' ? descriptor().backendExtension : { backend, codexHome: null },
        capabilities: { ...descriptor().capabilities, input: { parts: ['text', 'image', 'file'], origins: ['owner'] } },
      } as SuSessionDescriptor;
      const nativeInputs: unknown[] = [];
      const execute = vi.fn(async (command: SuSessionCommand) => {
        const saved = (await storedTurns()).find(turn => (turn.su_command.command as SuSessionCommand).commandId === command.commandId)!;
        expect(saved.su_command.command).toEqual(command);
        const prepared = await prepareSuSessionInput(saved.su_command.command as { content: string; input: never[] }, { workspaceId, root: tmpdir() });
        nativeInputs.push(prepared[backend]);
        return { status: 'completed' as const };
      });
      const host = new SuSessionHost({ descriptor: snapshot, executeCommand: execute });
      const command = { ...ownerTurn(`${backend}-persisted-image`), target: snapshot.identity,
        input: [{ type: 'image' as const, mediaType: 'image/png', data }] };
      await expect((await host.acceptCommand(command)).terminal).resolves.toMatchObject({ status: 'completed' });
      host.dispose();
      const replacement = new SuSessionHost({ descriptor: snapshot, executeCommand: execute });
      try {
        const replay = await replacement.acceptCommand(command);
        expect(replay.replayed).toBe(true);
        await expect(replay.terminal).resolves.toMatchObject({ status: 'completed' });
        expect(execute).toHaveBeenCalledOnce();
        const saved = (await storedTurns()).find(turn => (turn.su_command.command as SuSessionCommand).commandId === command.commandId)!;
        const prepared = await prepareSuSessionInput(saved.su_command.command as typeof command, { workspaceId, root: tmpdir() });
        expect(prepared[backend]).toEqual(nativeInputs[0]);
        expect(JSON.stringify(prepared[backend])).toContain(data);
      } finally { replacement.dispose(); }
    }
  });

  it.each(['revoked', 'moved', 'deleted', 'expired', 'foreign-workspace', 'changed', 'unsupported-media'] as const)(
    'SU-EXEC R-6 acceptance contract: revalidates a persisted %s reference for both providers', async scenario => {
      const root = mkdtempSync(join(tmpdir(), 'su-durable-reference-'));
      const path = join(root, 'notes.txt'), bytes = Buffer.from('Only this file contains the answer: 雪');
      const acceptedAt = Date.parse('2026-10-26T12:00:00Z');
      try {
        for (const backend of ['claude', 'codex'] as const) {
          writeFileSync(path, bytes); chmodSync(path, 0o600);
          await sql`UPDATE harness_shared.adv_sessions SET agent = ${backend} WHERE id = ${advSessionId}`;
          const snapshot = { ...descriptor(), identity: { ...descriptor().identity, backend },
            backendExtension: backend === 'claude' ? descriptor().backendExtension : { backend, codexHome: null },
            capabilities: { ...descriptor().capabilities, input: { parts: ['text', 'image', 'file'], origins: ['owner'] } },
          } as SuSessionDescriptor;
          const command = { ...ownerTurn(`${backend}-${scenario}`), target: snapshot.identity,
            input: [{ type: 'file' as const, uri: 'project:notes.txt', workspaceId,
              sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/plain',
              expiresAt: new Date(acceptedAt + 60_000).toISOString() }] };
          const host = new SuSessionHost({ descriptor: snapshot, executeCommand: async () => ({ status: 'completed' }) });
          try { await expect((await host.acceptCommand(command)).terminal).resolves.toMatchObject({ status: 'completed' }); }
          finally { host.dispose(); }
          const saved = (await storedTurns()).find(turn => (turn.su_command.command as SuSessionCommand).commandId === command.commandId)!
            .su_command.command as typeof command;
          const authority = { workspaceId, root, now: acceptedAt };
          const prepared = await prepareSuSessionInput(saved, authority);
          expect(JSON.stringify(prepared[backend])).toContain(bytes.toString());
          expect(saved.input).toEqual(command.input);
          if (scenario === 'revoked') chmodSync(path, 0);
          if (scenario === 'moved') renameSync(path, join(root, 'moved.txt'));
          if (scenario === 'deleted') rmSync(path);
          if (scenario === 'changed') writeFileSync(path, 'Different content under the same name');
          const replay = scenario === 'unsupported-media'
            ? { ...saved, input: saved.input.map(part => ({ ...part, mediaType: 'application/zip' })) } : saved;
          const expected = scenario === 'expired' ? 'input_expired'
            : scenario === 'foreign-workspace' ? 'input_workspace_mismatch'
              : scenario === 'changed' ? 'input_identity_changed'
                : scenario === 'unsupported-media' ? 'unsupported_input_media_type' : 'input_unreadable';
          await expect(prepareSuSessionInput(replay, { ...authority,
            ...(scenario === 'expired' ? { now: acceptedAt + 60_000 } : {}),
            ...(scenario === 'foreign-workspace' ? { workspaceId: 'other-workspace' } : {}),
          })).rejects.toMatchObject({ code: expected, retryable: false });
          // The durable receipt remains the selected reference, not an expanded path or newly granted authority.
          const retained = (await storedTurns()).find(turn => (turn.su_command.command as SuSessionCommand).commandId === command.commandId)!;
          expect((retained.su_command.command as typeof command).input).toEqual(command.input);
          rmSync(path, { force: true });
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('refuses a revoked persisted file when content is prepared for a replacement runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'su-durable-input-'));
    const path = join(root, 'private.txt'), bytes = Buffer.from('private content'); writeFileSync(path, bytes);
    const snapshot = descriptor();
    snapshot.capabilities = { ...snapshot.capabilities, input: { parts: ['file'], origins: ['owner'] } };
    const host = new SuSessionHost({ descriptor: snapshot, executeCommand: async () => ({ status: 'completed' }) });
    const command = { ...ownerTurn('persisted-file'), input: [{ type: 'file' as const, uri: 'project:private.txt',
      workspaceId, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/plain' }] };
    try {
      await (await host.acceptCommand(command)).terminal;
      const saved = (await storedTurns())[0].su_command.command as typeof command;
      await prepareSuSessionInput(saved, { workspaceId, root });
      chmodSync(path, 0);
      await expect(prepareSuSessionInput(saved, { workspaceId, root })).rejects.toMatchObject({ code: 'input_unreadable' });
      await expect(prepareSuSessionInput(saved, { workspaceId: 'foreign-workspace', root }))
        .rejects.toMatchObject({ code: 'input_workspace_mismatch' });
      expect(saved.input).toEqual(command.input);
    } finally { host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it('old-client-compatibility: preserves legacy descriptors and refuses unadvertised extended commands', async () => {
    const legacy = descriptor();
    expect(await persistSuSessionDescriptor(advSessionId, legacy, workspaceId)).toBe(true);
    const restoredLegacy = await readDurableSuSession({ advSessionId, workspaceId });
    expect(restoredLegacy?.descriptor).toEqual(legacy);
    expect(restoredLegacy?.descriptor?.executionKind).toBeUndefined();
    expect(restoredLegacy?.terminalBin).toBeNull();
    await sql`UPDATE harness_shared.adv_sessions SET terminal_bin = 'pui-structured-claude' WHERE id = ${advSessionId}`;
    expect((await readDurableSuSession({ advSessionId, workspaceId }))?.terminalBin).toBe('pui-structured-claude');
    const legacyExecute = vi.fn(async () => ({ status: 'completed' as const }));
    const legacyHost = new SuSessionHost({ descriptor: restoredLegacy!.descriptor!, executeCommand: legacyExecute });
    const unsupported = await legacyHost.acceptCommand({ ...ownerTurn('legacy-queue'), type: 'queue' });
    expect(await unsupported.terminal).toMatchObject({ refusal: { code: 'unsupported' } });
    expect(legacyExecute).not.toHaveBeenCalled();
    legacyHost.dispose();
  });

  it('durable-descriptor-command-receipt-roundtrip: preserves four provider/execution combinations with typed commands and receipts', async () => {
    for (const backend of ['claude', 'codex'] as const) {
      for (const executionKind of ['pty', 'programmatic'] as const) {
        const snapshot = { ...descriptor(), executionKind,
          identity: { ...descriptor().identity, backend },
          backendExtension: backend === 'claude' ? descriptor().backendExtension : { backend, codexHome: null },
          capabilities: { ...descriptor().capabilities, version: 2,
            commands: { ...descriptor().capabilities.commands, queue: { state: 'supported', implementation: 'host' },
              steer: { state: 'supported', implementation: 'host' }, handoff: { state: 'supported', implementation: 'host' } },
            input: { parts: ['text', 'image', 'file'], origins: ['owner', 'coordination'] } },
        } as SuSessionDescriptor;
        await sql`UPDATE harness_shared.adv_sessions SET agent = ${backend} WHERE id = ${advSessionId}`;
        expect(await persistSuSessionDescriptor(advSessionId, snapshot, workspaceId)).toBe(true);
        const saved = await readDurableSuSession({ advSessionId, workspaceId });
        expect(saved?.descriptor).toEqual(snapshot);
        const execute = vi.fn(async (cmd: SuSessionCommand) => {
          const turns = await storedTurns();
          expect(turns.find(turn => (turn.su_command.command as SuSessionCommand).commandId === cmd.commandId)?.su_command.command).toEqual(cmd);
          return { status: 'completed' as const };
        });
        const host = new SuSessionHost({ descriptor: saved!.descriptor!, executeCommand: execute });
        const prefix = `${backend}-${executionKind}`;
        const base = { ...ownerTurn(prefix), target: snapshot.identity, expectedRuntimeGeneration: 1 };
        const inputs = [
          { ...base, type: 'queue', commandId: `${prefix}-queue`, turnId: `${prefix}-queued`, origin: { kind: 'coordination', actorId: 'su-peer', sourceId: 'coord-1' },
            input: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
              { type: 'file', uri: 'attachment:1', mediaType: 'text/plain', name: 'notes.txt' }] },
          { ...base, type: 'steer', commandId: `${prefix}-steer`, turnId: `${prefix}-steered`, activeTurnId: 'active-1' },
          { schema: SU_SESSION_SCHEMA, protocolVersion: 1, type: 'handoff', commandId: `${prefix}-handoff`, issuedAt: base.issuedAt,
            target: snapshot.identity, expectedRuntimeGeneration: 1, provider: backend, executionKind },
        ];
        for (const cmd of inputs) expect(await (await host.acceptCommand(cmd)).terminal).toMatchObject({ status: 'completed' });
        host.dispose();
        const replacement = new SuSessionHost({ descriptor: snapshot, executeCommand: execute });
        for (const cmd of inputs) {
          const replay = await replacement.acceptCommand(cmd);
          expect(replay.replayed).toBe(true);
          expect(await replay.terminal).toMatchObject({ status: 'completed' });
        }
        expect(execute).toHaveBeenCalledTimes(inputs.length);
        // Coordination input was preserved and cannot be replayed as an owner directive.
        const ownerReceipts = await loadSuOwnerTurnReceipts(snapshot.identity);
        expect(ownerReceipts.some(turn => turn.turnId === `${prefix}-queued`)).toBe(false);
        expect(ownerReceipts.some(turn => turn.turnId === `${prefix}-steered`)).toBe(true);
        const turns = await storedTurns();
        expect(turns.find(turn => (turn.su_command.command as SuSessionCommand).commandId === `${prefix}-queue`))
          .toMatchObject({ origin: { kind: 'coordination', sourceId: 'coord-1' }, su_command: { command: inputs[0] } });
        replacement.dispose();
      }
    }
  });

  it('persists legacy control receipts and refuses to re-execute them after host replacement', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const control = { ...ownerTurn('control'), type: 'interrupt', reason: 'owner requested stop' };
    expect(await (await host.acceptCommand(control)).terminal).toMatchObject({ status: 'completed' });
    host.dispose();
    const replacement = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    expect((await replacement.acceptCommand(control)).replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('commits the exact owner turn before the HTTP acknowledgement and replays after host replacement', async () => {
    const execute = vi.fn(async () => {
      expect((await storedTurns())[0].content).toBe(ownerTurn().content);
      return { status: 'completed' as const };
    });
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    registerSuSessionHost(host);
    const response = await runWithWorkspace(workspaceId, () => suSessionRoutes[2].handler(
      new Request('http://localhost/api/su-session/commands', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ownerTurn()),
      }),
      { params: { slug: harnessSlug, chatId: agentChatId } } as never,
    ));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, accepted: { status: 'accepted' } });
    const dispatch = await host.acceptCommand(ownerTurn());
    expect((await dispatch.terminal).status).toBe('completed');
    _resetSuSessionHostsForTest();
    const replacement = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    await expect(replacement.acceptCommand({ ...ownerTurn(), content: 'changed' })).rejects.toMatchObject({
      code: 'command_id_conflict',
    });
    const replay = await replacement.acceptCommand(ownerTurn());
    expect(replay.replayed).toBe(true);
    expect((await replay.terminal).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await storedTurns()).toHaveLength(1);
  });

  it('EI-24367810949873789: preserves a committed acceptance after the HTTP deadline without executing a retry twice', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    registerSuSessionHost(host);
    const command = ownerTurn('delayed-reservation');
    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT id FROM harness_shared.agent_chats_consolidated
        WHERE workspace_id = ${workspaceId} AND id = ${agentChatId} FOR UPDATE`;
      reportLocked();
      await release;
      // Read through the lock-holding transaction: the fixture has two pool
      // connections and the other is waiting to reserve the turn.
      const [row] = await tx<{ transcript: unknown[] }[]>`
        SELECT transcript FROM harness_shared.agent_chats_consolidated
         WHERE workspace_id = ${workspaceId} AND id = ${agentChatId}`;
      expect(row.transcript).toHaveLength(0);
    });
    await locked;

    let reportDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => { reportDeadline = resolve; });
    const route = suSessionRoutes.find((candidate) => candidate.method === 'POST')!;
    const app = new Hono();
    registerRoute(app, {
      ...route,
      auth: 'public', // Isolate dispatch/receipt behavior from the socket auth layer.
      timeoutSec: 0.01,
      handler: (request, context) => {
        context.signal.addEventListener('abort', reportDeadline, { once: true });
        return route.handler(request, { ...context, input: undefined });
      },
    });
    const send = () => runWithWorkspace(workspaceId, () => app.request(
      '/harness/' + harnessSlug + '/agent-chats/' + agentChatId + '/su-session/commands',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) },
    ));
    const pending = send();
    try {
      await deadline;
      expect(execute).not.toHaveBeenCalled();
      releaseLock();
      await blocker;

      const response = await pending;
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ ok: true, accepted: { status: 'accepted' } });
      const dispatch = await host.acceptCommand(command);
      expect((await dispatch.terminal).status).toBe('completed');
      const replay = await send();
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
      expect(execute).toHaveBeenCalledTimes(1);
      const turns = await storedTurns();
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe(command.content);
    } finally {
      releaseLock();
      await blocker;
      await pending;
    }
  });

  it('reserves one turn under concurrent connections', async () => {
    const store = pgSuSessionCommandStore({ sql });
    const reservations = await Promise.all(Array.from({ length: 6 }, () => store.reserve(ownerTurn(), 'exact-payload')));
    expect(reservations.filter((r) => r.created)).toHaveLength(1);
    expect(await storedTurns()).toHaveLength(1);
  });

  it('WI-10004252: lists this session\'s saved owner turns in acceptance order, and nothing else', async () => {
    const store = pgSuSessionCommandStore({ sql });
    const turn = (commandId: string, content: string) => ({ ...ownerTurn(commandId), content });
    await store.reserve(turn('first', 'hi'), 'fp-1');
    // Turns that are not this session's receipts: a plain chat turn, and a
    // receipt saved for a different native session in the same conversation.
    const foreign = { ...turn('foreign', 'hi'), target: { ...descriptor().identity, nativeSessionId: 'another-native-session' } };
    await sql`
      UPDATE harness_shared.agent_chats_consolidated
         SET transcript = transcript || ${JSON.stringify([
           { role: 'user', content: 'typed elsewhere', source: 'operator' },
           { role: 'user', content: 'hi', source: 'su-session', su_command: { fingerprint: 'fp-x', command: foreign } },
         ])}::jsonb
       WHERE workspace_id = ${workspaceId} AND id = ${agentChatId}`;
    await store.reserve(turn('second', 'continue'), 'fp-2');
    await store.reserve(turn('third', 'continue'), 'fp-3');

    expect(await loadSuOwnerTurnReceipts(descriptor().identity, { sql })).toEqual([
      { turnId: 'turn-first', content: 'hi' },
      { turnId: 'turn-second', content: 'continue' },
      { turnId: 'turn-third', content: 'continue' },
    ]);
    // Calibration: the same read scoped to the other native session finds
    // exactly the foreign receipt, so the filter above excluded a real row.
    expect(await loadSuOwnerTurnReceipts(foreign.target, { sql })).toEqual([{ turnId: 'turn-foreign', content: 'hi' }]);
  });

  it.each(['owner_turn', 'queue'] as const)('survives a restart between %s reservation and dispatch without silently re-executing', async type => {
    // Crash injection at the only safe handoff point: committed, not dispatched.
    const store = pgSuSessionCommandStore({ sql });
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const interruptedStore = {
      ...store,
      reserve: async (...args: Parameters<typeof store.reserve>) => {
        await store.reserve(...args);
        throw new Error('injected host exit before acknowledgement');
      },
    };
    const originalDescriptor = descriptor();
    const savedDescriptor = { ...originalDescriptor, capabilities: { ...originalDescriptor.capabilities,
      commands: { ...originalDescriptor.capabilities.commands, queue: { state: 'supported', implementation: 'host' } as const },
    } };
    const savedCommand = { ...ownerTurn(), type };
    const host = new SuSessionHost({ descriptor: savedDescriptor, executeCommand: execute });
    await expect(host.acceptCommand(savedCommand, interruptedStore)).rejects.toThrow('injected host exit');
    host.dispose();
    const replacement = new SuSessionHost({ descriptor: savedDescriptor, executeCommand: execute });
    const replay = await replacement.acceptCommand(savedCommand, store);
    expect(replay.replayed).toBe(true);
    expect(await replay.terminal).toMatchObject({ refusal: { code: 'command_delivery_unknown' } });
    expect(execute).not.toHaveBeenCalled();
    expect(await storedTurns()).toHaveLength(1);
    expect((await storedTurns())[0].su_command.command).toEqual(savedCommand);
  });

  it('rejects cross-workspace, wrong-owner and archived targets without persisting text', async () => {
    const store = pgSuSessionCommandStore({ sql });
    for (const target of [
      { ...ownerTurn().target, workspaceId: 'another-workspace' },
      { ...ownerTurn().target, ownerId: 'another-owner' },
      { ...ownerTurn().target, harnessSlug: 'another-project' },
      { ...ownerTurn().target, nativeSessionId: 'another-engine-session' },
    ]) {
      await expect(store.reserve({ ...ownerTurn(), target }, 'payload')).rejects.toThrow('identity-bound');
    }
    await sql`UPDATE harness_shared.agent_chats_consolidated SET archived_at = ${Date.now()}
      WHERE workspace_id = ${workspaceId} AND id = ${agentChatId}`;
    await expect(store.reserve(ownerTurn(), 'payload')).rejects.toThrow('identity-bound');
    expect(await storedTurns()).toHaveLength(0);
  });

  it('does not repeat execution when the host loses persistence after acknowledgement', async () => {
    const store = pgSuSessionCommandStore({ sql });
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const accepted = await host.acceptCommand(ownerTurn(), {
      ...store, finish: async () => { throw new Error('injected loss after dispatch'); },
    });
    expect(accepted.accepted?.status).toBe('accepted');
    expect(await accepted.terminal).toMatchObject({ refusal: { code: 'command_delivery_unknown', retryable: false } });
    expect(execute).toHaveBeenCalledTimes(1);
    host.dispose();
    const replacement = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const replay = await replacement.acceptCommand(ownerTurn(), store);
    expect(await replay.terminal).toMatchObject({ refusal: { code: 'command_delivery_unknown' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await storedTurns()).toHaveLength(1);
  });
});
