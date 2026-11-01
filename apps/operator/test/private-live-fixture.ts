/** Shared test-only boundaries for the existing isolated PTY and lock journeys. */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

export function privateLiveTarget(env: Record<string, string | undefined>) {
  assert.equal(env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'run inside the maintained isolated verifier');
  const base = new URL(env.VERIFY_TAURI_DEV_URL ?? '');
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.ok(base.port && !['3055', '3070', '3170'].includes(base.port), 'private HTTP port required');
  assert.equal(base.href, base.origin + '/', 'exact private origin required');
  assert.equal(env.VERIFY_TAURI_PORT, base.port, 'HTTP handoff differs');
  const workspace = env.PAPERCUSP_WORKSPACE_ID;
  assert.ok(workspace?.startsWith('verify-tauri-isolated-'), 'private verifier workspace required');
  assert.equal(env.PAPERCUSP_WORKSPACE, workspace);
  assert.ok(env.PAPERCUSP_HOME, 'private token home required');
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1', 'ambient PG discovery must be disabled');
  const dsn = new URL(env.HARNESS_ADMIN_DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(dsn.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(dsn.hostname) && dsn.port && dsn.port !== '5432', 'private PG port required');
  assert.equal(dsn.port, env.PAPERCUSP_PG_PORT, 'PG handoff differs');
  return { base: base.origin, workspace, home: env.PAPERCUSP_HOME };
}

export async function freshPtyProtocols(url: string, headers: HeadersInit, request = fetch): Promise<string[]> {
  const response = await request(url, { method: 'POST', headers });
  assert.equal(response.status, 200, 'real PTY ticket endpoint must succeed');
  const issued = await response.json();
  assert.equal(issued.protocol, 'papercusp-pty.v1');
  assert.ok(typeof issued.ticket === 'string' && issued.ticket.startsWith('papercusp-pty-ticket.v1.'));
  return [issued.protocol, issued.ticket];
}

/** Retain each created row before readback, so partial setup can still clean up. */
export async function registerPrivateLockOwners(workspaceId: string, owners: Array<{ coordOwnerId: string; sessionId: string }>, createdIds: number[],
  api: Pick<typeof import('@papercusp/operator-core/lib/adv-sessions'), 'recordAdvSession' | 'workspaceForCoordOwner' | 'classifyOwnerNativeSession'>) {
  for (const { coordOwnerId, sessionId } of owners) {
    const id = await api.recordAdvSession({ workspaceId, mode: 'console', coordOwnerId, sessionId });
    assert.ok(id != null, 'private owner registration failed');
    createdIds.push(id);
    assert.equal(await api.workspaceForCoordOwner(coordOwnerId), workspaceId, 'private owner workspace readback differs');
    const binding = await api.classifyOwnerNativeSession({ ownerId: coordOwnerId, sessionId, workspaceId, advSessionId: id });
    assert.equal(binding.binding, 'bound', 'private native session readback differs');
    assert.equal(binding.advSessionId, id, 'private native session row differs');
  }
}

/** Cancel every owner's queued work before releasing any owner's held lock. */
export async function cleanupPrivateLockOwners(owners: string[], call: (owner: string, tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const failures: unknown[] = [];
  for (const owner of owners) {
    try {
      const queue = await call(owner, 'locks:queue', { owner });
      assert.ok(Array.isArray(queue.waiting), 'queue preflight/cleanup must return actual dispatch results');
      for (const waiter of queue.waiting as Array<{ ticket_id: string }>) {
        assert.equal((await call(owner, 'locks:cancel_wait', { ticket_id: waiter.ticket_id })).ok, true);
      }
    } catch (error) { failures.push(error); }
  }
  for (const owner of owners) {
    try {
      assert.equal((await call(owner, 'locks:release', { all_mine: true })).ok, true);
      const clean = await call(owner, 'locks:queue', { owner });
      assert.deepEqual(clean.active_locks, []);
      assert.deepEqual(clean.waiting, []);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'private lock cleanup failed');
}

/** Register before awaiting open: replay can be delivered immediately afterwards. */
export function observePtySocket(ws: WebSocket) {
  ws.binaryType = 'arraybuffer';
  let bytes = '';
  ws.on('message', (data, binary) => {
    if (binary) bytes += Buffer.from(data as ArrayBuffer).toString('utf8');
  });
  const opened = new Promise<{ opened: boolean; statusCode?: number }>((resolve) => {
    ws.once('open', () => resolve({ opened: true }));
    ws.once('unexpected-response', (_req, response) => {
      response.resume();
      resolve({ opened: false, statusCode: response.statusCode });
    });
    ws.once('close', () => resolve({ opened: false }));
    ws.on('error', () => { /* close follows; also handles terminate during cleanup */ });
  });
  return { ws, opened, output: () => bytes };
}
