/**
 * WI-10003879 — an SU session's requests reach the worker that holds its engine.
 *
 * Reproduces the pui-chat-first-ux P-023 failure shape across REAL processes:
 * two forked workers on their real IPC channels, this test process as the
 * cluster primary running the production `startPrimaryOwnerRpcRelay`. Worker A
 * opens the engine (as a PUI launch does on the worker that served it); worker B
 * never saw the launch. Before the fix B answered from a descriptor-only host:
 * `executorAttached:false` and the first owner turn refused "not ready".
 *
 * Proof: B's snapshot reports A's live executor, B's owner turn is accepted and
 * executed BY A, and B's event stream relays an event A publishes afterwards.
 * Negative controls: with no owner record, or a record whose nonce does not
 * match (a recycled pid), B must NOT forward; once A is dead B falls back.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
} from '@papercusp/chat-protocol';
import {
  startPrimaryOwnerRpcRelay,
  type OwnerRpcClusterLike,
  type OwnerRpcHandle,
  type OwnerRpcWorkerLike,
} from './cluster-owner-rpc';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'su-session-owner-worker.mts');

interface FixtureWorker { child: ChildProcess; pid: number }

const listeners = new Set<(worker: unknown, message: unknown) => void>();
const workers: Record<string, OwnerRpcWorkerLike> = {};
const cluster: OwnerRpcClusterLike = {
  on: (_event, cb) => listeners.add(cb),
  off: (_event, cb) => listeners.delete(cb),
  workers,
};

let relay: OwnerRpcHandle;
let a: FixtureWorker;
let b: FixtureWorker;
let seq = 0;

async function startWorker(id: string): Promise<FixtureWorker> {
  const child = fork(FIXTURE, [], {
    cwd: REPO_ROOT,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const worker: OwnerRpcWorkerLike = {
    process: { pid: child.pid },
    send: (message) => child.send(message as never),
    isDead: () => child.exitCode !== null || child.signalCode !== null,
    isConnected: () => child.connected,
  };
  child.on('message', (message) => { for (const cb of listeners) cb(worker, message); });
  const ready = await new Promise<{ pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture ${id} did not become ready`)), 60_000);
    child.on('message', (m: any) => {
      if (m?.type === 'fixture:ready') { clearTimeout(timer); resolve(m); }
    });
    child.once('exit', (code) => reject(new Error(`fixture ${id} exited early (${code})`)));
  });
  workers[id] = worker;
  return { child, pid: ready.pid };
}

function op<T = any>(w: FixtureWorker, message: Record<string, unknown>, onStreamOpen?: () => void): Promise<T> {
  const id = ++seq;
  return new Promise((resolve) => {
    const onMessage = (m: any) => {
      if (m?.type === 'fixture:stream-open' && m.seq === id) onStreamOpen?.();
      if (m?.type === 'fixture:result' && m.seq === id) {
        w.child.off('message', onMessage);
        resolve(m.out);
      }
    };
    w.child.on('message', onMessage);
    w.child.send({ type: 'fixture:op', seq: id, ...message });
  });
}

const target = {
  agentChatId: 'chat-owner-routing', advSessionId: 77, backend: 'claude', nativeSessionId: 'native-77',
  ownerId: 'su-fixture', workspaceId: 'fixture-workspace', harnessSlug: 'fixture',
};
const ownerTurn = (commandId: string) => ({
  schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION, commandId,
  issuedAt: '2026-10-05T00:00:00.000Z', target, type: 'owner_turn', turnId: `turn-${commandId}`, content: 'hi',
});

let owner: { pid: number; hostId: string; nonce: string; recordedAt: string };

beforeAll(async () => {
  relay = startPrimaryOwnerRpcRelay({ cluster });
  [a, b] = await Promise.all([startWorker('1'), startWorker('2')]);
  owner = (await op(a, { op: 'open-engine' })).owner;
}, 90_000);

afterAll(async () => {
  relay?.stop();
  for (const w of [a, b]) {
    if (w && w.child.exitCode === null && w.child.signalCode === null) {
      w.child.kill('SIGTERM');
      await once(w.child, 'exit').catch(() => undefined);
    }
  }
});

describe('su-session owner routing across cluster workers (WI-10003879)', () => {
  it('without an owner record the sibling does NOT reach the engine (the P-023 shape)', async () => {
    await op(b, { op: 'set-owner-record', owner: null });
    expect((await op(b, { op: 'route-kind' })).kind).not.toBe('remote');
    const snap = await op(b, { op: 'route', request: { op: 'snapshot' } });
    // No durable row in the fixture, so B has nothing at all to answer with.
    expect(snap.status).toBe(404);
  });

  it('a record whose nonce does not match (recycled pid) is refused by the owner and served locally', async () => {
    await op(b, { op: 'set-owner-record', owner: { ...owner, nonce: 'not-the-owners-nonce' } });
    const snap = await op(b, { op: 'route', request: { op: 'snapshot' } });
    expect(snap.servedBy).toBe(`local:${b.pid}`);
    expect(snap.status).toBe(404);
  });

  it('routes the snapshot to the owning worker, which reports its live executor', async () => {
    await op(b, { op: 'set-owner-record', owner });
    expect((await op(b, { op: 'route-kind' })).kind).toBe('remote');
    const snap = await op(b, { op: 'route', request: { op: 'snapshot' } });
    expect(snap.status).toBe(200);
    expect(snap.servedBy).toBe(`forwarded:${a.pid}`);
    expect(snap.body).toMatchObject({ ok: true, executorAttached: true, streamReady: true, terminal: false });
    expect(snap.body.descriptor.lifecycle).toBe('ready');
  });

  it("accepts the sibling's first owner turn and runs it on the owner", async () => {
    const res = await op(b, { op: 'route', request: { op: 'command', body: ownerTurn('first-hi') } });
    expect(res.status).toBe(202);
    expect(res.servedBy).toBe(`forwarded:${a.pid}`);
    expect(res.body).toMatchObject({ ok: true, replayed: false, accepted: { status: 'accepted', commandType: 'owner_turn' } });
    let executed: string[] = [];
    for (let i = 0; i < 50 && !executed.length; i++) {
      executed = (await op(a, { op: 'executed' })).executed;
      if (!executed.length) await new Promise((r) => setTimeout(r, 50));
    }
    expect(executed).toEqual([`owner_turn:${a.pid}`]);
  });

  it('relays the owner\'s live events to a stream opened on the sibling', async () => {
    const marker = `live-event-${Date.now()}`;
    const out = await op(
      b,
      { op: 'stream', untilText: marker, signalOpen: true, timeoutMs: 20_000 },
      () => { void op(a, { op: 'emit', text: marker }); },
    );
    expect(out.servedBy).toBe(`forwarded:${a.pid}`);
    // Replay carried the owner's history (including the turn it executed) ...
    expect(out.text).toContain(`owner ${a.pid} handled owner_turn`);
    // ... and a publish made AFTER the stream opened arrived through the relay.
    expect(out.text).toContain(marker);
  }, 30_000);

  it('native paid calls use only the owner observation/meter, consume once and retain unsettled holds', async () => {
    const nativeOwner = (await op(a, { op: 'open-native-engine' })).owner;
    await op(b, { op: 'set-owner-record', owner: nativeOwner });
    // An authenticated native transport alone grants no unit.
    expect(await op(b, { op: 'native-route', request: { callId: 'unobserved' } })).toMatchObject({ isError: true });
    expect(await op(a, { op: 'native-meter' })).toMatchObject({ nativeInvocations: 0, units: {}, reservedMicros: '0' });

    await op(a, { op: 'native-observe', callId: 'native-call' });
    const call = { op: 'native-route', request: { callId: 'native-call' } };
    expect(await op(b, call)).toMatchObject({ content: [{ text: `paid-owner:${a.pid}` }] });
    expect(await op(b, call)).toMatchObject({ isError: true });
    let meter = await op(a, { op: 'native-meter' });
    expect(meter).toMatchObject({ nativeInvocations: 1, channelCommittedMicros: '250', reservedMicros: '250', outstandingMicros: '0' });
    expect(Object.values(meter.units)).toHaveLength(1);

    // A wrapper's original observation authorizes one indirect target.
    await op(a, { op: 'native-observe', callId: 'wrapper-call', indirect: true });
    const wrapper = { op: 'native-route', request: { callId: 'wrapper-call', indirect: true } };
    expect(await op(b, wrapper)).toMatchObject({ content: [{ text: `paid-owner:${a.pid}` }] });
    expect(await op(b, wrapper)).toMatchObject({ isError: true });

    await op(a, { op: 'native-observe', callId: 'failed-call' });
    // Completion alone cannot release a hold when the signed receipt is absent.
    const failed = { op: 'native-route', request: { callId: 'failed-call', fail: true, settlementFail: true } };
    expect(await op(b, failed)).toMatchObject({ isError: true });
    expect(await op(b, failed)).toMatchObject({ isError: true });
    await op(a, { op: 'native-stop' });
    meter = await op(a, { op: 'native-meter' });
    expect(meter).toMatchObject({ nativeInvocations: 3, channelCommittedMicros: '500', reservedMicros: '750',
      outstandingMicros: '250', admissionClosed: true });
    expect(Object.values(meter.units)).toHaveLength(3);
    expect(Object.values(meter.units).filter((unit: any) => !unit.hasReceipt)).toHaveLength(1);
    expect(await op(b, { op: 'native-meter' })).toMatchObject({ nativeLocalCalls: 0, nativeInvocations: 0, units: {} });
    // Restore the original host's record for the remaining service-routing test.
    await op(b, { op: 'set-owner-record', owner });
  }, 30_000);

  it.each(['claude', 'codex'])('delivers %s private forms and URL completion to their real owning worker', async backend => {
    let opened = await op(a, { op: 'open-private-card', backend });
    expect(opened.error).toBeUndefined();
    await op(b, { op: 'set-owner-record', owner: opened.owner });
    await op(b, { op: 'set-card-record', record: opened.record });
    let card = opened.events.find((event: any) => event.type === 'card' && event.phase === 'opened').card;
    const input = { workspaceId: target.workspaceId, agentChatId: 'native-card-chat', request: {
      kind: 'response', correlationId: card.correlationId, action: 'submit', payload: { value: 'private-response' } } };
    expect(await op(b, { op: 'private-card-route', input: { ...input, agentChatId: 'foreign-chat' } })).toBeNull();
    expect(await op(b, { op: 'private-card-route', input: { ...input, workspaceId: 'foreign-workspace' } })).toBeNull();
    expect((await op(a, { op: 'private-card-state' })).answer).toBeNull();
    expect(await op(b, { op: 'private-card-route', input })).toEqual({ kind: 'response', ok: true });
    const state = await op(a, { op: 'private-card-state' });
    const answer = backend === 'claude' ? state.answer : state.answer.result;
    expect(answer).toMatchObject({ action: 'accept', content: { apiKey: 'private-response' } });
    expect(JSON.stringify(state.events)).not.toContain('private-response');
    expect((await op(b, { op: 'private-card-route', input }))).toMatchObject({ ok: false, status: 404 });
    expect((await op(b, { op: 'private-card-state' })).answer).toBeNull();

    opened = await op(a, { op: 'open-private-card', backend, url: true });
    expect(opened.error).toBeUndefined();
    card = opened.events.find((event: any) => event.type === 'card' && event.phase === 'opened').card;
    expect(JSON.stringify(opened.events)).not.toContain('PRIVATE_NATIVE');
    const link = { workspaceId: target.workspaceId, request: { kind: 'link', correlationId: card.correlationId } };
    expect(await op(b, { op: 'private-card-route', input: link }))
      .toEqual({ kind: 'link', target: 'https://auth.example/?code=PRIVATE_NATIVE' });
    expect(await op(b, { op: 'private-card-route', input: { ...link, request: {
      kind: 'response', correlationId: card.correlationId, action: 'decline' } } }))
      .toEqual({ kind: 'response', ok: true });
    expect(await op(b, { op: 'private-card-route', input: link })).toEqual({ kind: 'link', target: null });
    const declined = (await op(a, { op: 'private-card-state' })).answer;
    expect(backend === 'claude' ? declined : declined.result).toMatchObject({ action: 'decline' });
    await op(b, { op: 'set-owner-record', owner });
  }, 30_000);

  it('falls back for ordinary session reads but never for native cards once the owner worker is gone', async () => {
    const opened = await op(a, { op: 'open-private-card', backend: 'claude', url: true });
    expect(opened.error).toBeUndefined();
    const card = opened.events.find((event: any) => event.type === 'card' && event.phase === 'opened').card;
    await op(b, { op: 'set-card-record', record: opened.record });
    await op(b, { op: 'set-owner-record', owner: opened.owner });
    a.child.kill('SIGKILL');
    await once(a.child, 'exit');
    const privateResult = await op(b, { op: 'private-card-route', input: { workspaceId: target.workspaceId,
      request: { kind: 'link', correlationId: card.correlationId } } });
    expect(privateResult).toMatchObject({ error: expect.stringContaining('su_native_tool_owner_owner_gone') });
    await op(b, { op: 'set-owner-record', owner });
    const snap = await op(b, { op: 'route', request: { op: 'snapshot' } });
    expect(snap.servedBy).toBe(`local:${b.pid}`);
    expect(snap.status).toBe(404);
  });
});
