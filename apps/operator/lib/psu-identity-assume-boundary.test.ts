// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import net from 'node:net';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { handoffPathFor, hostThroughPty, metaPathFor } from '../scripts/psu-pty-host.mjs';

async function control(sock: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let bytes = '';
    conn.setTimeout(3000, () => conn.destroy(new Error('fixture control timed out')));
    conn.once('error', reject);
    conn.on('data', data => { bytes += data.toString(); });
    conn.once('end', () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
    conn.once('connect', () => conn.end(JSON.stringify(message)));
  });
}

// A local CLI fixture exercises the real PTY/result/completion/exit boundary.
// Its native-format rows are fixtures, not provider-backed takeover evidence.
it('retains the real caller through its result and reaps it before handing the surface to the launcher', async () => {
  const ownerId = `test-assume-boundary-${randomUUID()}`;
  const nativeId = randomUUID();
  const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_SID: ownerId, PAPERCUSP_WORKSPACE: 'test-workspace',
    PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) });
  const root = join(env.CODEX_HOME!, nativeId);
  env.CODEX_HOME = root;
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const transcript = join(sessions, `rollout-${nativeId}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n');
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const signals = new EventEmitter();
  let output = '', callerPid = 0;
  let boundary: { callerAlive: boolean; discoveryExists: boolean } | null = null;
  const prepare = vi.fn(async () => {
    const path = handoffPathFor(ownerId);
    writeFileSync(path, JSON.stringify({ fixture: true }));
    return { code: 75, handoffPath: path };
  });
  const onReexec = vi.fn(() => {
    let callerAlive = true;
    try { process.kill(callerPid, 0); } catch (error) { callerAlive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    boundary = { callerAlive, discoveryExists: existsSync(metaPathFor(ownerId)) };
  });
  const done = hostThroughPty({ command: process.execPath,
    args: ['-e', "process.stdout.write('FIXTURE_READY\\n');setInterval(()=>{},1000)"], cwd: process.cwd(),
    ownerId, env, resolveRespawnNativeId: () => nativeId,
    identityAssume: { verify: async () => true, prepare }, onReexec,
    signalSource: signals, emitCompacted: () => null, onExit: () => {}, bridgeTty: false,
    io: { stdin, stdout: { isTTY: false, columns: 100, rows: 30, write(data: string) { output += data; return true; } } },
  });
  try {
    const meta = await vi.waitFor(() => {
      const value = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
      expect(output).toContain('FIXTURE_READY'); return value;
    }, { timeout: 5000 });
    callerPid = meta.ptyPid;
    const caller = { ownerId, workspaceId: 'test-workspace', nativeSessionId: nativeId, nativePid: callerPid,
      hostId: meta.identityAssume.hostId, attachmentId: meta.identityAssume.attachmentId, childGeneration: meta.childGeneration };
    const request = { transitionKey: `session-assume:${'a'.repeat(64)}`, preparationHash: 'b'.repeat(64),
      recoveryRef: 'carry-note:fixture', recoveryHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000, caller };
    const send = (action: string) => control(meta.sock, { v: 1, mode: 'identity-assume', ownerId, action, request });
    expect(await send('freeze')).toMatchObject({ ok: true });
    expect(await send('queue')).toMatchObject({ ok: true });
    const receipt = { transitionKey: request.transitionKey, preparationFingerprint: request.preparationHash,
      state: 'handoff-accepted', durable: true, preparation: { caller: { ...caller, backend: 'codex' } },
      recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash } };
    appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'assume-call', output: JSON.stringify(receipt) } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(prepare).not.toHaveBeenCalled();
    expect(onReexec).not.toHaveBeenCalled();
    expect(() => process.kill(callerPid, 0)).not.toThrow();
    appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'assume-turn' } }) + '\n');
    await vi.waitFor(() => expect(onReexec).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(boundary).toEqual({ callerAlive: false, discoveryExists: false });
    expect(await done).toBe(75);
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    signals.emit('SIGTERM'); await done;
    rmSync(root, { recursive: true, force: true });
    rmSync(handoffPathFor(ownerId), { force: true });
  }
}, 20_000);
