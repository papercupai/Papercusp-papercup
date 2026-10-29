import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './_egress';

const tauriPid = process.env.VERIFY_TAURI_PID ?? '';
const tauriTools = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
const tauriPoll = process.env.VERIFY_TAURI_POLL ?? '';
const phaseDir = process.env.VH_PHASE_DIR ?? '';

function runTauri(args: string[], timeout = 30_000): string {
  return execFileSync(tauriTools, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout,
  });
}

function pollTauri(args: string[], timeout = 60_000): string {
  if (!tauriPoll) throw new Error('VERIFY_TAURI_POLL is required by the isolated Tauri rig');
  return execFileSync(tauriPoll, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout,
  });
}

test('the /dev right rail reports API readiness through the :3055 Vite proxy', async () => {
  test.setTimeout(180_000);
  expect(tauriPid, 'isolated Tauri process id').not.toBe('');
  expect(phaseDir, 'retained verifier phase directory').not.toBe('');

  const probe = runTauri(['probe', '--pid', tauriPid, '--json']);
  runTauri(['navigate', '--pid', tauriPid, '/dev']);

  const row = '.pc-dev-build > div:nth-child(3)';
  const labelCheck = pollTauri([
    '--selector', `${row} > span`,
    '--text', 'API via :3055',
    '--no-errors',
  ]);
  const statusCheck = pollTauri([
    '--selector', `${row} > strong`,
    '--text', 'up',
    '--no-errors',
  ]);
  const structuredCheck = runTauri([
    'check', '--pid', tauriPid,
    '--selector', `${row} > strong`,
    '--text', 'up',
    '--no-errors', '--json',
  ]);

  const evidenceDir = join(phaseDir, 'playwright');
  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = join(evidenceDir, 'dev-api-via-3055.png');
  runTauri(['screenshot', '--pid', tauriPid, '--output', screenshotPath]);
  expect(existsSync(screenshotPath), 'Tauri screenshot retained').toBe(true);

  writeFileSync(join(evidenceDir, 'dev-api-via-3055.json'), `${JSON.stringify({
    page: '/dev',
    indicator: { label: 'API via :3055', status: 'up' },
    labelCheck,
    statusCheck,
    structuredCheck,
    probe,
    screenshotPath,
    sourceRef: process.env.VERIFY_TAURI_SOURCE_REF ?? null,
    capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
});
