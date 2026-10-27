// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { buildResumeEnv, codexHomeLaunchReadiness, prepareCodexGatewayLaunch } from '../scripts/psu-launcher.mjs';
import { HOST_HANDOFF_ENV_KEYS, hostThroughPty, socketPathFor, eventLogPathForOwner } from '../scripts/psu-pty-host.mjs';
import { injectIntoHost, injectIntoHostWithConfirmation } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

// EI-26842368936683990: exercise the real carry preflight and PTY/socket seam.
// The child and signed-profile text are isolated fixtures, not a model session
// or evidence that a server authenticated this synthetic role signature.
it.each(['scoper', 'judge'])('keeps the %s predecessor alive after a privileged home repair', async role => {
  const root = mkdtempSync(join(tmpdir(), 'pty-role-authority-'));
  const ownerId = `test-role-${role}-${process.pid}-${Date.now()}`;
  const configPath = join(root, 'config.toml');
  const roleConfig = `[mcp_servers.papercusp]\nurl = "http://operator/api/mcp?role=${role}&client=${ownerId}&sig=fixture-signature"\n` +
    '[tui]\nterminal_title = []\nalternate_screen = "never"\n';
  const privilegedConfig = `[mcp_servers.papercusp-su]\nurl = "http://operator/api/mcp?superuser=1&client=${ownerId}"\n` +
    '[tui]\nterminal_title = []\nalternate_screen = "never"\n';
  writeFileSync(join(root, 'AGENTS.md'), '# Isolated role authority fixture\n');
  writeFileSync(configPath, roleConfig);
  writeFileSync(join(root, 'papercusp-diagnostics.json'), JSON.stringify({ lockOwnerSid: ownerId }));
  writeFileSync(join(root, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(
    ['SessionStart', 'SessionEnd', 'Stop'].map(event => [event, [{ hooks: [{
      command: `PAPERCUSP_SID='${ownerId}' lifecycle-report.sh`,
    }] }]]),
  ) }));
  expect(codexHomeLaunchReadiness(root, ownerId, role)).toBeNull();

  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  const signalSource = new EventEmitter();
  const resumed = buildResumeEnv({ agent: 'codex', role, coordOwnerId: ownerId, id: 7 },
    { accountEnv: { mode: 'default', env: {} } });
  const adopted = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(resumed)
    .filter(([key]) => HOST_HANDOFF_ENV_KEYS.includes(key)))));
  const env = hermeticEnv({ ...adopted, CODEX_HOME: root,
    PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '30', PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '500',
    PAPERCUSP_PSU_PTY_REARM_CAP_MS: '1000' });
  const childCode = "process.stdin.setRawMode(true);process.stdout.write('ROLE-READY\\n');" +
    "process.stdin.on('data',()=>process.stdout.write('PREDECESSOR-ALIVE\\n'));" +
    'setTimeout(()=>process.exit(0),15000);';
  const prepare = vi.fn((args: string[]) => prepareCodexGatewayLaunch(env, args));
  const repair = vi.fn(async () => {
    writeFileSync(configPath, privilegedConfig);
    expect(codexHomeLaunchReadiness(root, ownerId, 'su')).toBeNull();
    return { ok: true };
  });
  const mint = vi.fn((args: string[]) => ({ args, nativeId: null }));
  const done = hostThroughPty({ command: process.execPath, args: ['-e', childCode],
    cwd: root, env, ownerId, io: { stdin, stdout }, signalSource, bridgeTty: false,
    onExit: () => {}, ensureCodexHome: repair, mintCarryRespawnArgs: mint,
    prepareChildArgs: prepare });
  const socket = socketPathFor(ownerId);
  const log = eventLogPathForOwner(ownerId);
  const events = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  try {
    await vi.waitFor(() => expect(output).toContain('ROLE-READY'), { timeout: 10000 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await injectIntoHostWithConfirmation(socket, { mode: 'carry-respawn', ownerId,
      data: 'isolated carry fixture', systemPromptAddendum: 'isolated carry fixture',
      deliveryId: `role-authority-${role}` })).toMatchObject({ ok: true, reason: 'accepted' });
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({
      kind: 'respawn-failed', mode: 'carry-respawn', reason: 'argv-build-failed',
      detail: 'Codex launch requires its recorded owner and restricted role MCP profile',
    })), { timeout: 6500 });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(events().filter(event => event.kind === 'pty-spawned')).toHaveLength(1);
    expect(events().some(event => event.kind === 'respawn-predecessor-stop-started')).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(privilegedConfig);
    expect(await injectIntoHost(socket, { mode: 'raw', ownerId, data: 'still here' })).toBe(true);
    await vi.waitFor(() => expect(output).toContain('PREDECESSOR-ALIVE'), { timeout: 3000 });
  } finally {
    signalSource.emit('SIGTERM');
    await done;
    rmSync(root, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
  expect(existsSync(socket)).toBe(false);
}, 20000);
