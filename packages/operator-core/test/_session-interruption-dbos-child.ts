/** Real DBOS controller for session-interruption-workflow.crash.integration.test.ts.
 * Only the final launcher is substituted; it creates the production managed PTY
 * around a deterministic native CLI. No provider or fleet is contacted. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBOS } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';
import type { SessionInterruptionRuntime } from '../lib/harness/routines/session-interruption-runtime';

const dsn = process.env.RECOVERY_CRASH_DSN!;
const root = process.env.RECOVERY_CRASH_ROOT!;
const owner = process.env.RECOVERY_CRASH_OWNER!;
const target = process.env.RECOVERY_CRASH_TARGET!;
const mode = process.env.RECOVERY_CRASH_MODE!;
if (!dsn || !root || !owner || !['crash', 'recover'].includes(mode) ||
    !new URL(dsn).pathname.startsWith('/org_')) throw new Error('private migrated recovery fixture required');
process.env.HARNESS_ADMIN_DATABASE_URL = dsn;
process.env.HARNESS_DATABASE_URL = dsn;
process.env.DATABASE_URL = dsn;
process.env.PAPERCUSP_PSU_PTY_DIR = join(root, 'pty');
process.env.PAPERCUSP_HOME = join(root, 'home');
process.env.PAPERCUSP_ROOT = join(root, 'home');
const ws = 'recovery-dbos-crash';
const native = '30c49db4-e1e3-4ac7-9bec-960c500b46ea';
const sql = postgres(dsn, { max: 2, onnotice: () => {} });
const killAt = async (point: string) => {
  if (mode === 'crash' && point === target) {
    process.stdout.write('RECOVERY_CRASH ' + point + '\n');
    process.kill(process.pid, 'SIGKILL');
    await new Promise<never>(() => {});
  }
};
DBOS.setConfig({ name: 'session-interruption-crash', systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos', applicationVersion: 'recovery-crash-v1', runAdminServer: false });
const workflow = await import('../lib/dbos/session-interruption-workflow');
const { createSessionInterruptionRuntime } = await import('../lib/harness/routines/session-interruption-runtime');
const { sessionRecoveryKey } = await import('../lib/harness/routines/session-interruption-recovery');
const { findLiveHostAsync } = await import('../lib/events/await/psu-pty-discovery');
const [row] = await sql`SELECT payload FROM harness_shared.psu_pty_host_events WHERE owner_id = ${owner}`;
const p = row.payload;
const input = { workspaceId: ws, installSlug: 'papercusp', ownerId: owner,
  key: sessionRecoveryKey({ ownerId: owner, nativeSessionId: native,
    hostPid: p.hostPid, hostStartedAt: p.hostStartedAt } as never) };
const workflowId = workflow.sessionInterruptionWorkflowId(input);
workflow.configureSessionInterruptionRuntime(async () => {
  const runtime = await createSessionInterruptionRuntime({ workspaceId: ws, installSlug: 'papercusp',
    triggerConfig: {}, payloadTemplate: null }, false, { initialize: false, actionId: workflowId,
    nativeLaunch: async ({ beforeNativeCreate }) => {
      await beforeNativeCreate();
      const config = join(root, 'codex');
      mkdirSync(join(config, 'sessions'), { recursive: true });
      writeFileSync(join(config, 'config.toml'), '');
      writeFileSync(join(config, 'sessions', `rollout-${native}.jsonl`), '');
      const hostPath = fileURLToPath(new URL('../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url));
      const nativeCode = "process.stdin.resume();setInterval(()=>process.stdout.write('.'),100)";
      const hostCode = `import {hostThroughPty} from ${JSON.stringify(hostPath)};
        import postgres from ${JSON.stringify(import.meta.resolve('postgres'))};
        import {EventEmitter} from 'node:events';
        const witness=postgres(process.env.RECOVERY_CRASH_DSN,{max:1,onnotice(){}});
        await witness.unsafe('INSERT INTO test_recovery.creations (owner_id,pid,workflow_id,native_session_id) VALUES ($1,$2,$3,$4)',
          [${JSON.stringify(owner)},process.pid,${JSON.stringify(workflowId)},${JSON.stringify(native)}]);
        await witness.end({timeout:2});
        const signalSource=new EventEmitter();
        process.on('SIGTERM',()=>signalSource.emit('SIGTERM'));
        await hostThroughPty({command:process.execPath,args:['-e',${JSON.stringify(nativeCode)}],
          cwd:${JSON.stringify(root)},ownerId:${JSON.stringify(owner)},env:process.env,
          activityPersistMs:25,resolveRespawnNativeId:()=>${JSON.stringify(native)},
          io:{stdin:Object.assign(new EventEmitter(),{isTTY:false,resume(){},pause(){}}),
          stdout:{isTTY:false,write(){return true;}}},signalSource,onExit(){}});`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('PAPERCUSP_') && !['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'NODE_PATH',
          'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(key)));
      const child = spawn(process.execPath, ['--input-type=module', '-e', hostCode], {
        detached: true, stdio: 'ignore', cwd: root,
        env: { ...env, CODEX_HOME: config, PAPERCUSP_SID: owner, PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_WORKSPACE_ID: ws, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY_DIR: join(root, 'pty') },
      });
      child.unref();
      // The child owns its witness: even death before the launch response or
      // any controller-side receipt cannot hide this surviving process.
      await killAt('after-native-spawn');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const host = await findLiveHostAsync(owner);
        if (host && host.pid === child.pid && host.nativeSessionId === native) {
          await killAt('after-native-creation');
          return { verified: true, reason: 'exact-native-host-verified' };
        }
        if (child.exitCode != null) throw new Error('managed PTY exited before identity observation');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('managed PTY identity deadline: ' + readFileSync(join(root, 'codex/config.toml'), 'utf8'));
    } });
  return { ...runtime,
    claim: async (...args: Parameters<SessionInterruptionRuntime['claim']>) => {
      await killAt('before-reservation');
      const claimed = await runtime.claim(...args);
      await killAt('after-reservation'); return claimed;
    },
    markDispatch: async (...args: Parameters<SessionInterruptionRuntime['markDispatch']>) => {
      const marked = await runtime.markDispatch(...args);
      await killAt('after-dispatch-intent'); return marked;
    },
    finish: async (...args: Parameters<SessionInterruptionRuntime['finish']>) => {
      await killAt('before-settlement');
      const settled = await runtime.finish(...args);
      await killAt('after-settlement'); return settled;
    },
  };
});
await DBOS.launch();
if (mode === 'crash') await DBOS.startWorkflow(workflow.sessionInterruptionWorkflow, { workflowID: workflowId })(input);
const outcome = await DBOS.getResult(workflowId, 60);
process.stdout.write('RECOVERY_OUTCOME ' + JSON.stringify({ workflowId, outcome }) + '\n');
await DBOS.shutdown();
await sql.end({ timeout: 2 });
process.exit(0);
