import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const evidencePath = join(evidenceDir, 'dev-api-via-3055.json');
  const nativeWindows = JSON.parse(runTauri(['list-windows', '--tauri', '--json'])) as Array<{
    windowId: string;
    pid?: number;
    name?: string;
  }>;
  const nativeWindow = nativeWindows.find((window) => window.pid === Number(tauriPid));
  if (!nativeWindow) throw new Error(`No native Tauri window found for verifier PID ${tauriPid}`);
  const captureDir = join(evidenceDir, 'dev-api-via-3055-capture');
  const screenshotPath = join(evidenceDir, 'dev-api-via-3055.png');
  const readinessEval = `(() => ({
    path: window.location.pathname,
    label: document.querySelector('${row} > span')?.textContent?.trim() ?? null,
    status: document.querySelector('${row} > strong')?.textContent?.trim() ?? null,
  }))()`;
  const evidence = {
    page: '/dev',
    indicator: { label: 'API via :3055', status: 'up' },
    labelCheck,
    statusCheck,
    structuredCheck,
    probe,
    evidencePath,
    captureDir,
    nativeWindow: { id: nativeWindow.windowId, name: nativeWindow.name ?? null, pid: nativeWindow.pid },
    sourceRef: process.env.VERIFY_TAURI_SOURCE_REF ?? null,
    capturedAt: new Date().toISOString(),
  };
  // Persist the successful readiness probes before optional visual capture. X11
  // ImageMagick can fail on a valid native window (EI-26300522815911971); the
  // capture command preserves that degradation in its manifest while still
  // collecting the page state and DOM needed to verify this check.
  writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, captureStatus: 'pending' }, null, 2)}\n`);

  let captureManifest: {
    errorCount?: number;
    partial?: boolean;
    files?: Record<string, string>;
  };
  try {
    captureManifest = JSON.parse(runTauri([
      'capture', '--pid', tauriPid, '--window-id', nativeWindow.windowId,
      '--output', captureDir, '--dom-depth', '8', '--eval', readinessEval,
      '--logs-duration', '250', '--json',
    ]));
  } catch (error) {
    writeFileSync(evidencePath, `${JSON.stringify({
      ...evidence,
      captureStatus: 'failed',
      captureError: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    throw error;
  }

  const manifestPath = join(captureDir, 'manifest.json');
  expect(existsSync(manifestPath), 'native capture manifest retained').toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof captureManifest;
  const requiredArtifacts = ['page-state.json', 'dom.json', 'eval.json'] as const;
  const artifactPaths = Object.fromEntries(requiredArtifacts.map((name) => [name, manifest.files?.[name] ?? null]));
  const missingArtifacts = requiredArtifacts.filter((name) => {
    const path = manifest.files?.[name];
    return !path || path.startsWith('error: ') || !existsSync(path);
  });
  const pageStatePath = manifest.files?.['page-state.json'];
  const evalPath = manifest.files?.['eval.json'];
  const pageState = pageStatePath && existsSync(pageStatePath)
    ? JSON.parse(readFileSync(pageStatePath, 'utf8')) as { url?: string }
    : null;
  const readinessState = evalPath && existsSync(evalPath)
    ? JSON.parse(readFileSync(evalPath, 'utf8')) as { path?: string; label?: string | null; status?: string | null }
    : null;
  const screenshotEntry = manifest.files?.['screenshot.png'] ?? 'error: no screenshot receipt in capture manifest';
  let retainedScreenshot: string | null = null;
  if (!screenshotEntry.startsWith('error: ') && existsSync(screenshotEntry)) {
    copyFileSync(screenshotEntry, screenshotPath);
    retainedScreenshot = screenshotPath;
  }
  writeFileSync(evidencePath, `${JSON.stringify({
    ...evidence,
    captureStatus: 'complete',
    manifestPath,
    capture: { errorCount: manifest.errorCount ?? null, partial: manifest.partial ?? null, files: manifest.files ?? {} },
    requiredArtifacts: artifactPaths,
    missingArtifacts,
    pageState,
    readinessState,
    screenshot: retainedScreenshot
      ? { status: 'captured', path: retainedScreenshot }
      : { status: 'degraded', error: screenshotEntry.slice('error: '.length) },
  }, null, 2)}\n`);

  expect(missingArtifacts, 'page state, DOM, and eval receipts retained').toEqual([]);
  expect(new URL(pageState?.url ?? 'about:blank').pathname, 'native page route').toBe('/dev');
  expect(readinessState, 'native DOM readiness evidence').toMatchObject({
    path: '/dev',
    label: 'API via :3055',
    status: 'up',
  });
});
