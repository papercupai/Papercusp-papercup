/** Real account-store/bootstrap-resolver -> launch preparation -> child inputs.
 * Controlled children observe route propagation; they do not claim provider
 * authentication, subscription entitlement, or execution of native hooks. */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hermeticEnv } from '../../../apps/operator/vitest-shims/psu-pty-temp-dir';
import { prepareSuLaunch } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { hostThroughPty } from '../../../apps/operator/scripts/psu-pty-host.mjs';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { writeOperatorState } from './operator-state-pg';
import { setAccountOverride } from './deployment/account-session-override';
import bootstrapRoutes, { resolveAccountPin } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { startSuStdioPeer } from './su-session-stdio-peer';

// Only managed-process enrollment is substituted. Keep the production framing,
// real child, close acknowledgement, account resolver, PG stores and preparation.
const transport = vi.hoisted(() => ({ children: new Map<string, ChildProcess>(), allocations: 0 }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (
  binary: string, args: string[], _spec: unknown, options: { spawnOptions: object },
) => {
  transport.allocations++;
  const child = spawn(binary, args, options.spawnOptions), taskId = randomUUID();
  transport.children.set(taskId, child);
  return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => {
  transport.children.get(id)?.kill('SIGKILL'); return { ok: true };
} }));
// The HTTP refusal cases retain the real handler, principal gate, account
// resolver and PG stores. Persona rendering and console discovery are unrelated
// leaves: replace those to avoid generating launch artifacts for refused input.
vi.mock('./console-launcher', () => ({ buildConsoleEnvelope: async () => ({ cwd: home, env: {} }) }));
vi.mock('./role-launch-spec', async importOriginal => ({
  ...await importOriginal<typeof import('./role-launch-spec')>(),
  buildLaunchSpec: async () => ({ kind: 'su', role: 'su', promptText: 'Chosen SU persona',
    promptFile: join(home, 'persona.md'), cwd: home, stack: [],
    mcpUrl: 'http://127.0.0.1:3070/api/mcp?superuser=1' }),
}));

const workspace = 'default';
let db: OrgTestDb | undefined;
let fixture: BaselineCoordFixture | undefined;
let home: string;
const flag = 'PAPERCUSP_FLAG_PAPERCUSP_INFERENCE_GATEWAY';
const priorityFlag = 'PAPERCUSP_FLAG_PAPERCUSP_GATEWAY_PRIORITY_TIERS';
const isolatedEnvKeys = [flag, priorityFlag, 'PAPERCUSP_LAUNCH_CONTEXT_DIR',
  'PAPERCUSP_SU_CODEX_HOMES_DIR', 'PAPERCUSP_CODEX_SQLITE_HOMES_DIR'] as const;
const previous = new Map(isolatedEnvKeys.map(key => [key, process.env[key]]));
beforeAll(async () => {
  db = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  home = mkdtempSync(join(tmpdir(), 'su-launch-eligibility-'));
  writeFileSync(join(home, 'persona.md'), 'Chosen SU persona');
  process.env[flag] = '1';
  process.env[priorityFlag] = '0';
  // Refusal mutants can reach artifact creation. Keep even that broken path
  // inside this fixture instead of the invoking workspace's native homes.
  process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = join(home, 'launch-context');
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = join(home, 'codex-homes');
  process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR = join(home, 'codex-sqlite');
}, 120_000);
beforeEach(async () => {
  transport.allocations = 0;
  await writeOperatorState('operator_account_pool', { accounts: [
    { id: 'chosen-claude', provider: 'claude', credentialRef: '', addedAt: 0, boundTo: [] },
    { id: 'chosen-codex', provider: 'codex', credentialRef: '', addedAt: 0, boundTo: [] },
    { id: 'bad-claude', provider: 'claude', credentialRef: '', addedAt: 0, boundTo: [],
      credentialFailure: { observedAt: 1, ownerId: 'su-confirmed-auth-failure' } },
    { id: 'bad-codex', provider: 'codex', credentialRef: '', addedAt: 0, boundTo: [],
      credentialFailure: { observedAt: 1, ownerId: 'su-confirmed-auth-failure' } },
  ] }, workspace);
  await setAccountOverride(workspace, { clear: true });
});
afterEach(() => {
  for (const child of transport.children.values()) if (child.exitCode === null) child.kill('SIGKILL');
  transport.children.clear();
});
afterAll(async () => {
  try { await fixture?.dispose(); } finally {
    try { await db?.cleanup(); } finally {
      if (home) rmSync(home, { recursive: true, force: true });
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
});

async function resolvedLaunch(agent: 'claude' | 'codex', account: string, executionKind: 'pty' | 'programmatic') {
  const ownerId = 'su-eligibility-' + randomUUID();
  const pin = await resolveAccountPin(workspace, account, agent, ownerId, true);
  if (pin.error) throw Object.assign(new Error(pin.error), { code: 'account_route_refused' });
  return prepareSuLaunch({ status: 'ok', agent, cwd: home, promptFile: join(home, 'persona.md'),
    model: agent === 'claude' ? 'claude-sonnet-4-6:high' : 'gpt-5.6-sol:high',
    nativeSessionId: ownerId, envelopeEnv: { ...pin.env, PAPERCUSP_SID: ownerId,
      PAPERCUSP_WORKSPACE: workspace, PAPERCUSP_LAUNCH_CONTEXT_FILE: join(home, 'persona.md'),
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: home } }, {
    executionKind, accountRoute: account,
    inheritedEnv: hermeticEnv({ ANTHROPIC_API_KEY: 'parent-credential', PAPERCUSP_ACCOUNT_ID: 'parent-account' }),
  });
}

async function observe(agent: 'claude' | 'codex', account: string, executionKind: 'pty' | 'programmatic') {
  const launch = await resolvedLaunch(agent, account, executionKind);
  const code = "const observed={route:process.env.PAPERCUSP_ACCOUNT_ROUTING_MODE,account:process.env.PAPERCUSP_ACCOUNT_ID??null,parentCredential:!!process.env.ANTHROPIC_API_KEY};" +
    (executionKind === 'pty' ? "console.log('SU_ELIGIBILITY:'+JSON.stringify(observed))" :
      "require('node:readline').createInterface({input:process.stdin}).on('line',l=>console.log(JSON.stringify({id:JSON.parse(l).id,result:observed})))");
  if (executionKind === 'pty') {
    transport.allocations++;
    let output = '';
    const exit = await hostThroughPty({ command: process.execPath, args: ['-e', code],
      cwd: launch.cwd, env: launch.env, ownerId: launch.env.PAPERCUSP_SID!,
      bridgeTty: false, signalSource: new EventEmitter(),
      io: { stdin: Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} }),
        stdout: { columns: 80, rows: 24, write: (data: string | Buffer) => { output += data.toString(); } } },
      onExit: () => undefined, emitCompacted: () => null });
    expect(exit).toBe(0);
    return JSON.parse(output.split('SU_ELIGIBILITY:')[1].split('\n')[0].trim());
  }
  const args = ['-e', code];
  const peer = await startSuStdioPeer({ binary: process.execPath, args, cwd: launch.cwd, env: launch.env,
    workspaceId: workspace, ownerId: launch.env.PAPERCUSP_SID!, onMessage: () => undefined,
    spec: { class: 'test', title: 'SU account eligibility transport observation', launchedBy: 'vitest', argv: [process.execPath, ...args] } });
  try { return await peer.request({ method: 'observe' }); }
  finally { await peer.close(); await peer.done; }
}

describe('SU bootstrap account eligibility through launch preparation', () => {
  for (const agent of ['claude', 'codex'] as const) {
    it(`${agent} successful HTTP bootstrap confines native artifacts to the fixture`, async () => {
      const route = (bootstrapRoutes as Array<{ method: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>)
        .find(entry => entry.method === 'POST')!;
      const response = await route.handler(new Request('http://127.0.0.1:3070/api/agent-mcp/console/bootstrap-su', {
        method: 'POST', headers: { host: '127.0.0.1:3070', 'content-type': 'application/json' },
        body: JSON.stringify({ agent, account: `chosen-${agent}`, workspace, cwd: home, headless: true,
          model: agent === 'codex' ? 'gpt-5.6-sol:high' : 'claude-sonnet-4-6:high' }),
      }), { log() {} });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.status).toBe('ok');
      expect(result.promptFile.startsWith(home + '/')).toBe(true);
      expect(readFileSync(result.promptFile, 'utf8')).toContain('Chosen SU persona');
      expect(transport.allocations).toBe(0);
    }, 60_000);

    it(`${agent} HTTP bootstrap refuses ineligible accounts without recording a session`, async () => {
      const route = (bootstrapRoutes as Array<{ method: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>)
        .find(entry => entry.method === 'POST')!;
      const count = async () => Number((await fixture!.admin`
        SELECT count(*) AS n FROM harness_shared.adv_sessions
      `)[0].n);
      const before = await count();
      for (const [account, reason] of [
        [`bad-${agent}`, /confirmed provider authentication failure/i],
        ['unknown-account', /not in the account pool/i],
        [`chosen-${agent === 'claude' ? 'codex' : 'claude'}`, /sessions require/i],
      ] as const) {
        const response = await route.handler(new Request('http://127.0.0.1:3070/api/agent-mcp/console/bootstrap-su', {
          method: 'POST', headers: { host: '127.0.0.1:3070', 'content-type': 'application/json' },
          body: JSON.stringify({ agent, account, workspace, cwd: home, headless: true,
            model: agent === 'codex' ? 'gpt-5.6-sol:high' : 'claude-sonnet-4-6:high' }),
        }), { log() {} });
        const result = await response.json();
        expect(response.status, JSON.stringify(result)).toBe(409);
        expect(result).toMatchObject({ status: 'error', error: expect.stringMatching(reason) });
      }
      expect(await count()).toBe(before);
      expect(transport.allocations).toBe(0);
    }, 60_000);

    for (const kind of ['pty', 'programmatic'] as const) {
      it(`${agent}/${kind} preserves explicit default, auto and pin through the real child`, async () => {
        for (const account of ['default', 'auto', `chosen-${agent}`]) {
          expect(await observe(agent, account, kind)).toEqual({
            route: account === 'default' ? 'default' : account === 'auto' ? 'auto' : 'pin',
            account: account.startsWith('chosen-') ? account : null, parentCredential: false,
          });
        }
        expect(transport.allocations).toBe(3);
      }, 20_000);

      it(`${agent}/${kind} refuses invalid eligibility before allocating any child`, async () => {
        for (const account of [`bad-${agent}`, 'unknown-account', `chosen-${agent === 'claude' ? 'codex' : 'claude'}`]) {
          await expect(observe(agent, account, kind)).rejects.toMatchObject({ code: 'account_route_refused' });
        }
        await setAccountOverride(workspace, { excludeAccounts: [`chosen-${agent}`] });
        await expect(observe(agent, `chosen-${agent}`, kind)).rejects.toThrow('exclude');
        process.env[flag] = '0';
        try { await expect(observe(agent, 'auto', kind)).rejects.toThrow('gateway is off'); }
        finally { process.env[flag] = '1'; }
        await writeOperatorState('operator_account_pool', { accounts: [] }, workspace);
        await expect(observe(agent, 'auto', kind)).rejects.toThrow('no allowed');
        expect(transport.allocations).toBe(0);
      });
    }
  }
});
