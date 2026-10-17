// @vitest-environment node
import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, eventLogPathForOwner } from '../scripts/psu-pty-host.mjs';
import { scanTextForSecrets } from '../../../packages/operator-core/lib/sync/pot-git/secrets-guard';

const failure = 'Error: account/read failed during TUI bootstrap: account/read failed: ' +
  'workspace routing discovery timed out (code -32603)';

it.each(['codex', 'claude'])('records a split pre-frame native discovery failure only for %s', async (agent) => {
  const ownerId = `test-bootstrap-${agent}-${process.pid}-${Date.now()}`;
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  const childCode = [
    `const failure=${JSON.stringify(failure)};`,
    "process.stdout.write('unrelated fixture secret=do-not-persist\\n\\x1b[?25h');",
    "setTimeout(()=>process.stdout.write(failure.slice(0,70)),30);",
    "setTimeout(()=>process.stdout.write(failure.slice(70)+'\\r\\n'),80);",
    "setTimeout(()=>process.stdout.write(failure+'\\r\\n'),130);",
    'setTimeout(()=>process.exit(1),200);',
  ].join('');
  await hostThroughPty({
    command: process.execPath, args: ['-e', childCode], cwd: process.cwd(), ownerId,
    env: hermeticEnv({ PAPERCUSP_AGENT: agent, PAPERCUSP_SID: ownerId }),
    io: { stdin, stdout }, bridgeTty: false, onExit: () => {},
  });
  expect(output).toContain(failure);
  const log = eventLogPathForOwner(ownerId);
  const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const failures = events.filter(row => row.kind === 'backend-bootstrap-failed');
  expect(failures).toHaveLength(agent === 'codex' ? 1 : 0);
  if (agent === 'codex') {
    expect(failures[0]).toMatchObject({ agent: 'codex', stage: 'account/read',
      reason: 'workspace-routing-discovery-timeout', gatewayRequested: false, accountPinPresent: false });
    expect(failures[0].msAfterFirstOutput).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(failures)).not.toContain('do-not-persist');
    expect(failures[0]).not.toHaveProperty('output');
  }
}, 15_000);

it.each([false, true])('retains a native pre-turn exit witness with diagnostic output=%s', async (withOutput) => {
  const ownerId = `test-native-exit-${withOutput}-${process.pid}-${Date.now()}`;
  const outputMarker = 'sample-sensitive-output-must-stay-out-of-events';
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  const childCode = withOutput
    ? `process.stderr.write(${JSON.stringify(outputMarker + '\n')}, () => process.exit(1));`
    : 'process.exit(1);';
  const result = await hostThroughPty({
    command: process.execPath, args: ['-e', childCode], cwd: process.cwd(), ownerId,
    env: hermeticEnv({ PAPERCUSP_AGENT: 'claude', PAPERCUSP_SID: ownerId }),
    io: { stdin, stdout }, bridgeTty: false, onExit: () => {},
  });
  expect(result).toBe(1);
  const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const spawn = events.find(row => row.kind === 'pty-spawned');
  const exits = events.filter(row => row.kind === 'pty-child-exited');
  expect(exits).toHaveLength(1);
  expect(exits[0]).toMatchObject({ childPid: spawn.childPid, agent: 'claude', generation: 1,
    exitCode: 1, signal: null, normalizedLogPath: null });
  expect(exits[0].msSinceSpawn).toBeGreaterThanOrEqual(0);
  expect(exits[0].outputBytes > 0).toBe(withOutput);
  expect(output.includes(outputMarker)).toBe(withOutput);
  expect(JSON.stringify(exits)).not.toContain(outputMarker);
  expect(exits[0]).not.toHaveProperty('output');
  expect(events.findIndex(row => row.kind === 'pty-child-exited')).toBeGreaterThan(
    events.findIndex(row => row.kind === 'pty-spawned'));
}, 15_000);

it('keeps the native-output fixtures publishable by the secret guard', () => {
  const path = 'apps/operator/lib/psu-pty-host-native-bootstrap.integration.test.ts';
  expect(scanTextForSecrets(path, readFileSync(new URL(import.meta.url), 'utf8'))).toEqual([]);
});
