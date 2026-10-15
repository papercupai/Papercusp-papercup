import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type IsolatedHostedTestUser = {
  sessionId: string;
  organizationId: string;
  workspaceId?: string;
  cookie(origin: string): { name: string; value: string; url: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' };
  cleanup(reason: string): Promise<void>;
};

export type IsolatedHostedTestUserKit = {
  create(opts: Record<string, unknown>): Promise<IsolatedHostedTestUser>;
  close(): Promise<void>;
};

// Reused by the browser journey and Vitest readiness. A retained Portal must
// load its entire admission graph in its own process: the caller may already
// have a different version of the process-global projected tool registry.
const worker = String.raw`
  import { register } from 'tsx/esm/api';
  import { pathToFileURL } from 'node:url';
  import { join, resolve } from 'node:path';
  // The child owns one candidate graph. Per-call tsImport creates a new
  // namespace for every import and discards that graph's module cache.
  const loader = register({ namespace: 'isolated-hosted-test-user' });
  const started = performance.now();
  const progress = (id, stage, phase) => process.send({ id, stage, phase,
    elapsedMs: Math.round(performance.now() - started) });
  const sourceImport = async (file, id, stage) => {
    progress(id, stage, 'started');
    const m = await loader.import(pathToFileURL(file).href, import.meta.url);
    progress(id, stage, 'finished');
    return { ...m.default, ...m };
  };
  let fixture, kit, user;
  const safeError = error => ({
    name: error?.name ?? 'Error',
    message: String(error?.message ?? error).replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, '[redacted]'),
    errors: error instanceof AggregateError ? error.errors.map(safeError) : undefined,
  });
  let pending = Promise.resolve();
  process.on('message', message => {
    pending = pending.then(async () => {
      const { id, op, opts, reason } = message;
      try {
        let value;
        if (op === 'preflight') {
          fixture = await sourceImport(resolve('e2e/hosted-test-user.ts'), id, 'fixture-module-import');
          const workspace = fixture.isolatedHostedWorkspaceContext(process.env);
          const { core } = fixture.hostedTestSourceRoots(process.cwd());
          // These imports previously happened after upstream account creation.
          // Validate their real runtime closure before permitting admission.
          for (const path of ['lib/workspace-host/observability-store.ts',
            'lib/auth/hosted/workspace-admission.ts', 'lib/auth/hosted/workspace-admission-dependencies.ts']) {
            await sourceImport(join(core, path), id, path);
          }
          value = { workspace };
        } else if (op === 'load') {
          kit = await fixture.loadHostedTestUserKit(process.cwd());
        } else if (op === 'create') {
          if (user) throw new Error('hosted_test_fixture_user_already_created');
          user = await kit.create(opts);
          value = { sessionId: user.sessionId, organizationId: user.organizationId,
            workspaceId: user.workspaceId, cookie: user.cookie('https://localhost') };
        } else if (op === 'cleanup' || op === 'close') {
          if (user) {
            const owned = user;
            user = undefined;
            await owned.cleanup(reason ?? 'isolated hosted TEST fixture disposal');
          }
        } else throw new Error('hosted_test_fixture_unknown_operation');
        process.send({ id, value }, () => { if (op === 'cleanup' || op === 'close') process.exit(0); });
      } catch (error) {
        process.send({ id, error: safeError(error) });
      }
    });
  });
`;

export async function loadIsolatedHostedTestUserKit(options: {
  portalRoot: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<IsolatedHostedTestUserKit> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker], {
    cwd: options.portalRoot, env: options.environment ?? process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise<void>(ready => child.once('exit', () => ready()));
  // A spawn failure can precede the first request's listeners.
  let spawnFailure: Error | undefined;
  child.on('error', error => { spawnFailure = error; });
  let closed = false;
  const startupDeadline = Date.now() + (options.timeoutMs ?? 60_000);
  async function stop() {
    if (closed) return;
    closed = true;
    if (child.exitCode !== null || child.signalCode !== null || spawnFailure) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  type RemoteError = { name: string; message: string; errors?: RemoteError[] };
  function restoreError(value: RemoteError): Error {
    if (value.errors) return new AggregateError(value.errors.map(restoreError), value.message);
    return Object.assign(new Error(value.message), { name: value.name });
  }
  async function request(op: string, payload: Record<string, unknown> = {}) {
    if (spawnFailure) throw spawnFailure;
    if (closed || child.exitCode !== null || child.signalCode !== null) throw new Error('Hosted TEST fixture already exited');
    const id = randomUUID();
    return await new Promise<any>((ready, reject) => {
      let finished = false;
      const finish = (error?: Error, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
        if (error) {
          // Ordinary reporters and hosted receipts retain message/stack, but
          // discard custom Error properties. Keep safe stage timings on that
          // boundary as well so a cold import failure remains diagnosable.
          if (importStages.length) error.message += '\nHosted TEST import stages: ' + JSON.stringify(importStages);
          reject(Object.assign(error, { importStages }));
        } else ready(value);
      };
      let stage = op;
      const importStages: Array<{ stage: string; phase: string; elapsedMs: number }> = [];
      const onMessage = (message: any) => {
        if (message.id !== id) return;
        if (message.stage) {
          stage = message.stage;
          importStages.push({ stage, phase: message.phase, elapsedMs: message.elapsedMs });
        } else finish(message.error ? Object.assign(restoreError(message.error), { importStages }) : undefined, message.value);
      };
      const onExit = (code: number | null) => finish(new Error(`Hosted TEST fixture exited before ${op}: ${code}`));
      const onError = (error: Error) => finish(error);
      const timeout = op === 'preflight' || op === 'load'
        ? Math.max(1, startupDeadline - Date.now()) : options.timeoutMs ?? 120_000;
      const timer = setTimeout(() => finish(Object.assign(
        new Error(`Hosted TEST fixture ${op} timed out at ${stage}`), { importStages },
      )), timeout);
      child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
      child.send({ id, op, ...payload }, error => { if (error) finish(error); });
    });
  }
  try {
    await request('preflight');
    await request('load');
    return {
      async create(opts) {
        try {
          const value = await request('create', { opts });
          return { sessionId: value.sessionId, organizationId: value.organizationId, workspaceId: value.workspaceId,
            cookie: (origin: string) => ({ ...value.cookie, url: origin }),
            cleanup: async (reason: string) => {
              try { await request('cleanup', { reason }); } finally { await stop(); }
            },
          };
        } catch (error) {
          // Admission owns its partial cleanup; dispose the child even if that
          // cleanup fails. Preserve the original error and its AggregateError.
          await stop();
          throw error;
        }
      },
      async close() {
        if (closed) return;
        try { await request('close'); } finally { await stop(); }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
