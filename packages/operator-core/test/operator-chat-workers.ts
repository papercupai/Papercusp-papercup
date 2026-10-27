import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { TurnIdentity } from '@papercusp/chat-protocol/recovery';
import type { InteractionScope } from '@papercusp/chat-protocol/interactions';

interface WorkerInput {
  databaseUrl: string;
  workspaceId: string;
  turn: TurnIdentity;
  scope: InteractionScope;
  token: string;
  action: { kind: 'recover'; callId: string } | {
    kind: 'finalize'; runId: string; text: string;
    status: 'completed' | 'failed' | 'cancelled';
  };
}
export interface ChatWorkerResult {
  pid: number;
  sourceHash: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const storePath = fileURLToPath(new URL('../lib/operator-chat-store.ts', import.meta.url));
export const chatWorkerSourceHash = () => createHash('sha256').update(readFileSync(storePath)).digest('hex');

/** Independent Node processes rendezvous before touching PG. No in-memory
 * store, module singleton, or parent connection can supply the recovered state. */
export async function runOperatorChatWorkers(inputs: WorkerInput[]): Promise<ChatWorkerResult[]> {
  const script = `
    import postgres from 'postgres';
    import { drizzle } from 'drizzle-orm/postgres-js';
    import { restoreRawJsonbSerializer } from '@papercusp/db-org';
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { OperatorChatStore, operatorChatSessionAuthority } from ${JSON.stringify(storePath)};
    import { TurnRecovery } from '@papercusp/chat-protocol/recovery';
    const input = JSON.parse(process.env.P010_PG_WORKER_INPUT);
    const sql = postgres(input.databaseUrl, { max: 1, onnotice() {} });
    restoreRawJsonbSerializer(sql);
    drizzle(sql);
    const sourceHash = createHash('sha256').update(readFileSync(${JSON.stringify(storePath)})).digest('hex');
    const authorize = operatorChatSessionAuthority({ workspaceId: input.workspaceId,
      principalId: input.scope.principalId, credential: { kind: 'user-session',
        token: input.token, userId: input.scope.principalId },
      capability: 'chat:write', toolName: 'operator:converse' });
    const store = new OperatorChatStore({ sql, ...input, replayLimit: 4, authorize });
    const start = new Promise(resolve => process.once('message', resolve));
    process.send({ ready: true });
    await start;
    let result;
    try {
      if (input.action.kind === 'finalize') {
        result = { ok: true, value: await store.finalizeTurn(input.action) };
      } else {
        const recovery = new TurnRecovery({ capabilities: { connectionReplay: true,
          persistedHistory: true, persistedInteractionDecisions: true,
          completedToolCheckpoints: true, interruptedTurnRecovery: true }, store,
          authorize: async () => true, replay: (id, after) => store.replay(id, after),
          abortExecution: async () => {} });
        result = await recovery.runEffect(input.turn, input.action.callId,
          async () => { throw new Error('completed-effect-was-redispatched'); }, new AbortController().signal);
      }
    } catch (error) { result = { ok: false, error: error.message }; }
    finally { await sql.end({ timeout: 5 }); }
    process.send({ result: { pid: process.pid, sourceHash, ...result } }, () => process.disconnect());
  `;
  const children: ChildProcess[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    const workers = inputs.map(input => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...process.env, P010_PG_WORKER_INPUT: JSON.stringify(input) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let stderr = '';
      child.stderr?.setEncoding('utf8'); // boundary-safe decode (WI-6728)
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<ChatWorkerResult>((resolve, reject) => {
        let received: ChatWorkerResult | undefined;
        const fail = (error: Error) => { readyReject(error); reject(error); };
        const timer = setTimeout(() => fail(new Error('P010 PG worker timed out')), 30_000);
        timers.push(timer);
        child.on('message', (message: { ready?: boolean; result?: ChatWorkerResult }) => {
          if (message.ready) readyResolve();
          if (message.result) received = message.result;
        });
        child.once('error', fail);
        child.once('close', code => {
          clearTimeout(timer);
          if (code !== 0 || !received) fail(new Error(`P010 PG worker exited ${code}: ${stderr}`));
          else resolve(received);
        });
      });
      // Attach a rejection handler while the other workers reach the barrier.
      void result.catch(() => {});
      return { child, ready, result };
    });
    await Promise.all(workers.map(worker => worker.ready));
    workers.forEach(worker => worker.child.send('start'));
    return await Promise.all(workers.map(worker => worker.result));
  } finally {
    timers.forEach(clearTimeout);
    children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  }
}
