/** Real process/transport launch-input checks. The child observes its own
 * argv, cwd and configuration bytes. This is not provider-inference proof. */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hermeticEnv } from '../../../apps/operator/vitest-shims/psu-pty-temp-dir';
import { prepareSuLaunch } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { hostThroughPty } from '../../../apps/operator/scripts/psu-pty-host.mjs';
import { startSuStdioPeer } from './su-session-stdio-peer';

// The test runner owns the cgroup. Substitute DB enrollment only; retain the
// production pipe framing, actual child process and exact-child teardown.
const children = vi.hoisted(() => new Map<string, ChildProcess>());
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (binary: string, args: string[], _spec: unknown, options: { spawnOptions: object }) => {
  const child = spawn(binary, args, options.spawnOptions), taskId = randomUUID();
  children.set(taskId, child);
  return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => {
  children.get(id)?.kill('SIGKILL'); return { ok: true };
} }));
const homes: string[] = [];
afterEach(() => {
  for (const child of children.values()) if (child.exitCode === null) child.kill('SIGKILL');
  children.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('shared SU launch inputs across real process transports', () => {
  it.each(['claude', 'codex'] as const)('%s child receives the chosen bootstrap without parent credentials', async agent => {
    const home = mkdtempSync(join(tmpdir(), 'su-launch-inputs-')); homes.push(home);
    const persona = join(home, 'persona.md'), config = join(home, 'config.json');
    writeFileSync(persona, 'Chosen SU persona with chosen hooks and tool policy');
    writeFileSync(config, JSON.stringify({ hooks: ['chosen-hook'], memory: ['chosen-memory'], tools: ['chosen-tool'] }));
    const ownerId = 'su-launch-input-' + randomUUID();
    const boot = { status: 'ok', agent, cwd: home, promptFile: persona,
      model: agent === 'codex' ? 'gpt-5.6-sol:high' : 'claude-sonnet-4-6:high',
      nativeSessionId: 'chosen-native', compactionLimit: 360000,
      envelopeEnv: { PAPERCUSP_SID: ownerId, PAPERCUSP_WORKSPACE: 'chosen-workspace',
        PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin', PAPERCUSP_ACCOUNT_ID: 'chosen-account',
        PAPERCUSP_LAUNCH_CONTEXT_FILE: persona, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home,
        SU_TEST_CONFIG: config } };
    const inheritedEnv = hermeticEnv({ HOME: home, ANTHROPIC_API_KEY: 'parent-must-not-reach-child',
      PAPERCUSP_ACCOUNT_ID: 'parent-account' });
    const prepare = (executionKind: 'pty' | 'programmatic') => prepareSuLaunch(boot, {
      executionKind, inheritedEnv, accountRoute: 'chosen-account', model: 'stale-caller:low',
    });
    const childCode = [
      "const fs=require('node:fs');",
      "const observed={argv:process.argv.slice(1),cwd:process.cwd(),owner:process.env.PAPERCUSP_SID,",
      "account:process.env.PAPERCUSP_ACCOUNT_ID,route:process.env.PAPERCUSP_ACCOUNT_ROUTING_MODE,",
      "parentCredentialPresent:!!process.env.ANTHROPIC_API_KEY,",
      "persona:fs.readFileSync(process.env.PAPERCUSP_LAUNCH_CONTEXT_FILE,'utf8'),",
      "config:JSON.parse(fs.readFileSync(process.env.SU_TEST_CONFIG,'utf8'))};",
      "if(process.env.SU_TEST_PIPE==='1'){require('node:readline').createInterface({input:process.stdin}).on('line',l=>{",
      "const request=JSON.parse(l);console.log(JSON.stringify({id:request.id,result:observed}));});}",
      "else console.log('SU_LAUNCH_OBSERVED:'+JSON.stringify(observed));",
    ].join('');
    const pty = prepare('pty'); let output = '';
    const exit = await hostThroughPty({ command: process.execPath,
      args: ['-e', childCode, '--', ...pty.args, ...pty.extraArgs], cwd: pty.cwd, env: pty.env,
      ownerId, bridgeTty: false, signalSource: new EventEmitter(),
      io: { stdin: Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} }),
        stdout: { columns: 80, rows: 24, write: (data: string | Buffer) => { output += data.toString(); } } },
      onExit: () => undefined, emitCompacted: () => null,
    });
    expect(exit).toBe(0);
    const terminalObserved = JSON.parse(output.split('SU_LAUNCH_OBSERVED:')[1].split('\n')[0].trim());
    const structured = prepare('programmatic');
    const args = ['-e', childCode, '--', ...structured.args, ...structured.extraArgs];
    const peer = await startSuStdioPeer({ binary: process.execPath, args, cwd: structured.cwd,
      env: { ...structured.env, SU_TEST_PIPE: '1' }, workspaceId: 'launch-input-test', ownerId,
      spec: { class: 'test', title: 'SU launch preparation process observation', launchedBy: 'vitest', argv: [process.execPath, ...args] },
      onMessage: () => undefined });
    try {
      const pipeObserved = await peer.request({ method: 'observe-launch' });
      expect(pipeObserved).toEqual(terminalObserved);
      expect(pipeObserved).toMatchObject({ cwd: home, owner: ownerId, account: 'chosen-account', route: 'pin',
        parentCredentialPresent: false, persona: 'Chosen SU persona with chosen hooks and tool policy',
        config: { hooks: ['chosen-hook'], memory: ['chosen-memory'], tools: ['chosen-tool'] } });
      expect(pipeObserved.argv).toContain(agent === 'codex' ? 'gpt-5.6-sol' : 'claude-sonnet-4-6');
    } finally { await peer.close(); await peer.done; }
  }, 15000);
});
