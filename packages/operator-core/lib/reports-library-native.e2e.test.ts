/** Real Reports journey inside the maintained, owned, isolated Tauri verifier. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bridgeEval } from '../../../libs/generic/tauri-verify/src/bridge-client';

const execute = promisify(execFile);
const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';
let nativeEnvironment: NodeJS.ProcessEnv;
let nativePID: number;

describe.skipIf(!isolated)('Reports library in the isolated native desktop', () => {
  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    nativePID = Number(process.env.VERIFY_TAURI_PID);
    expect(profile.tauriPID).toBe(nativePID);
    expect(nativePID).toBeGreaterThan(0);
    expect(typeof profile.nativeTmpDir).toBe('string');
    expect(isAbsolute(profile.nativeTmpDir)).toBe(true);
    // Vitest deliberately relocates TMPDIR. The owned desktop was booted before
    // that boundary, so its CLI must retain the measured native discovery root.
    nativeEnvironment = { ...process.env, TMPDIR: profile.nativeTmpDir };
    const bridge = JSON.parse(readFileSync(join(profile.nativeTmpDir,
      `tauri-dev-bridge-${nativePID}.token`), 'utf8'));
    expect(bridge.pid).toBe(nativePID);
    const authenticated = await bridgeEval({ tauriPID: nativePID,
      bridgePort: bridge.port, bridgeToken: bridge.token }, 'true');
    expect(authenticated.ok, authenticated.ok ? undefined : authenticated.error).toBe(true);
    console.log(`REPORTS_NATIVE_BRIDGE_ROOT=${profile.nativeTmpDir} workerTmpDir=${tmpdir()}`);
  });

  it('keeps owned bridge discovery across the runner temp-directory boundary', async () => {
    const cli = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
    const args = ['eval', 'true', '--pid', String(nativePID)];
    const positive = await execute(cli, args, { env: nativeEnvironment, timeout: 15_000 });
    expect(positive.stdout.trim()).toBe('true');
    const emptyRoot = mkdtempSync(join(tmpdir(), 'reports-bridge-negative-'));
    try {
      await expect(execute(cli, args, { env: { ...nativeEnvironment, TMPDIR: emptyRoot },
        timeout: 15_000 })).rejects.toThrow(/No bridge/);
      expect((await execute(cli, args, { env: nativeEnvironment, timeout: 15_000 })).stdout.trim()).toBe('true');
    } finally { rmSync(emptyRoot, { recursive: true, force: true }); }
  }, 45_000);

  it('publishes through the real tool and proves SSE, reader and agent controls in Tauri', async () => {
    const sourceRoot = process.env.OPERATOR_SOURCE_ROOT;
    expect(sourceRoot, 'Use scripts/verify-tauri-headless.sh with a committed source pin').toBeTruthy();
    expect(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'A verified source receipt is required').toBeTruthy();
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL, 'Keep the result in the shared test ledger').toBeTruthy();
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE, 'Measure the owned running host').toBeTruthy();
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(receipt.schemaVersion).toBe('verifier-source-v1');
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);

    // The assertions and the host load the same frozen source. The maintained
    // driver owns fixture publication, DOM polling, source integrity and screenshots.
    const result = await execute(process.execPath, ['--import', 'tsx',
      join(sourceRoot!, 'scripts/tauri-surface-verify-reports.mts')], {
      cwd: sourceRoot, env: nativeEnvironment, timeout: 280_000, maxBuffer: 4 * 1024 * 1024,
    });
    const match = result.stdout.match(/REPORTS_LIBRARY_TAURI_PASS evidence=(.+)/);
    expect(match, `${result.stdout}\n${result.stderr}`).not.toBeNull();
    const manifestPath = join(match![1].trim(), 'phases/native/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.result).toBe('pass');
    expect(manifest.original).not.toBe(manifest.correction);
    expect(manifest.privatePeer).toBeTruthy();
    expect(manifest.sse.before.sse.connectedSinceMs).not.toBeNull();
    expect(manifest.sse.afterPublish.invalidations.bySseName['reports.list'])
      .toBeGreaterThan(manifest.sse.before.invalidations.bySseName['reports.list'] ?? 0);
    expect(manifest.retired).toBe(manifest.correction);
    expect(manifest.sse.afterRetire.invalidations.bySseName['reports.list'])
      .toBeGreaterThan(manifest.sse.beforeRetire.invalidations.bySseName['reports.list'] ?? 0);
    expect(manifest.checked).toEqual(expect.arrayContaining([
      'publish-tool', 'publish-exact-readback', 'unknown-citation-isolation',
      'SSE-arrival', 'deep-link', 'metadata', 'Mermaid-render',
      'copy-exact-Markdown', 'immutable-citation', 'history-navigation',
      'agent-tools-filter-state-roundtrip', 'agent-tools-reader-close-reopen',
      'filter-negative-control', 'reader-width', 'human-owner-private-read',
      'retire-tool', 'SSE-retirement', 'retired-citation-readback',
    ]));
    // Preserve exact receipts in the recorded test output, so bindings can cite
    // the native evidence rather than substituting an earlier successful run.
    console.log(`REPORTS_NATIVE_E2E_MANIFEST=${manifestPath}`);
    console.log(`REPORTS_NATIVE_E2E_SOURCE_RECEIPT=${process.env.VERIFY_TAURI_SOURCE_RECEIPT}`);
  }, 300_000);
});
