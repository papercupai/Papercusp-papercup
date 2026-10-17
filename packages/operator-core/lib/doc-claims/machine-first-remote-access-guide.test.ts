import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parsePsuConnectionArgs,
  runPsuConnectionFrontController,
} from '../../../../apps/operator/scripts/psu-connection-front-controller.mjs';

const root = new URL('../../../../', import.meta.url);
const guide = readFileSync(
  process.env.PAPERCUSP_REMOTE_ACCESS_GUIDE ?? new URL('apps/operator-docs/src/content/docs/harness/remote-access-guide.mdx', root),
  'utf8',
);
const host = readFileSync(
  process.env.PAPERCUSP_REMOTE_SESSION_HOST ?? new URL('packages/operator-core/lib/workspace-host/hosted-session-host.ts', root),
  'utf8',
);

describe('machine-first remote access guide', () => {
  it('gives executable personal SSH setup, terminal and browser commands', () => {
    const commands = [...guide.matchAll(/`(psu --[^`\n]+)`/g)].map(match => match[1]!);
    const setup = commands.find(command => command.includes('--connect-add-ssh='));
    const terminal = commands.find(command => command === 'psu --connect=my-computer');
    const browser = commands.find(command => command.includes('--connect-gui'));
    expect(setup, 'the guide needs an actual saved-SSH setup command').toBeDefined();
    expect(terminal, 'the guide needs a remote terminal command').toBeDefined();
    expect(browser, 'the guide needs a browser GUI command').toBeDefined();
    const parse = (command: string) => parsePsuConnectionArgs(command.split(/\s+/).slice(1));
    expect(parse(setup!)).toMatchObject({
      transport: { addSshName: 'my-computer', sshHost: 'my-computer' }, forwardedArgv: [],
    });
    expect(parse(terminal!)).toMatchObject({
      transport: { explicitConnect: true, selection: 'my-computer', gui: false }, forwardedArgv: [],
    });
    expect(parse(browser!)).toMatchObject({
      transport: { explicitConnect: true, selection: 'my-computer', gui: true }, forwardedArgv: [],
    });
  });

  it('keeps the documented hosted retention period equal to the host default', () => {
    const configured = /export const HOSTED_HOST_SESSION_IDLE_MS\s*=\s*(\d+)\s*\*\s*([\d_]+)\s*;/.exec(host);
    expect(configured, 'the host idle default must be measured, never guessed').not.toBeNull();
    const documented = /(\d+) minutes after detachment/.exec(guide);
    expect(documented, 'the guide must name the bounded hosted retention window').not.toBeNull();
    const actualMs = Number(configured![1]) * Number(configured![2]!.replaceAll('_', ''));
    expect(Number(documented![1]) * 60_000).toBe(actualMs);
    expect(actualMs).toBeGreaterThan(0);
  });

  it('attributes commands and context to the selected remote machine and sends the documented command there', async () => {
    expect(guide).toContain('Context and tool calls belong to the selected remote workspace');
    expect(guide).toContain('the laptop terminal runs the local front controller');
    expect(guide).toContain('the remote tmux session runs psu');
    const home = mkdtempSync(join(tmpdir(), 'pc-guide-execution-'));
    const notices: string[] = [];
    const sessions: Array<{ command: string; args: string[] }> = [];
    const commands = [...guide.matchAll(/`(psu --[^`\n]+)`/g)].map(match => match[1]!);
    const setup = commands.find(command => command.includes('--connect-add-ssh='))!;
    const terminal = commands.find(command => command === 'psu --connect=my-computer')!;
    try {
      await runPsuConnectionFrontController(setup.split(/\s+/).slice(1), {
        home, interactive: false, output: () => {},
      });
      const result = await runPsuConnectionFrontController(terminal.split(/\s+/).slice(1), {
        home, interactive: false, commandAvailable: () => true,
        notice: (message: string) => notices.push(message),
        reservePort: async () => ({ port: 45125, release: async () => {} }),
        probeOperator: async () => {},
        runCommand: async (_command: string, args: string[]) => ({ code: args.includes('check') ? 1 : 0 }),
        runInteractive: async (command: string, args: string[]) => {
          sessions.push({ command, args });
          return { code: 0 };
        },
      });
      expect(result).toMatchObject({ handled: true, exitCode: 0 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.command).toBe('ssh');
      expect(sessions[0]!.args.at(-2)).toBe('my-computer');
      expect(sessions[0]!.args.at(-1)).toContain("'tmux' 'new-session'");
      expect(sessions[0]!.args.at(-1)).toContain("'env' 'PAPERCUSP_PSU_CONNECTION_FORWARDED=1' 'psu'");
      expect(notices.join('\n')).toContain('my-computer');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps personal SSH access separate from app keys, public ingress and key revocation', () => {
    expect(guide).toContain('External-app keys and the scoped relay above do not provide full GUI or shell access');
    expect(guide).toContain('127.0.0.1:3070');
    expect(guide).toContain('SSH host key, identity and authorization remain OpenSSH policy');
    expect(guide).toContain('Removing the saved profile forgets it locally');
    expect(guide).toContain('revoke the SSH key on the remote computer to remove access');
    expect(guide).toContain('An offline host or refused key cannot open a terminal or browser');
    expect(guide).toContain('BYOC content must use an authorized sealed channel or customer-controlled ingress');
  });

  it('names the complete execution path and keeps download and credential boundaries explicit', () => {
    for (const participant of ['Laptop psu front controller', 'Portal ticket and connector relay',
      'Host psu supervisor', 'Customer-account agent', 'Workspace operator', 'Model provider']) {
      expect(guide, `missing process: ${participant}`).toContain(` as ${participant}`);
    }
    expect(guide).toContain('customer identity and workspace cwd');
    expect(guide).toContain('Retrieve context and call authorized tools');
    expect(guide).toContain('The laptop keeps its portal CLI token');
    expect(guide).toContain('does not receive arbitrary service credentials or a service-user shell');
    expect(guide).toContain('A requested download does not prove that a file was saved or installed');
    expect(guide).toContain('### Local, managed and BYOC machines');
  });
});
