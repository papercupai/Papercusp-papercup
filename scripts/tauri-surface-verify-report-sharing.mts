/** Explicit harmless GitHub fixture acceptance on an owned, source-pinned rig. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,PAPERCUSP_TEST_RUN_GROUP,PAPERCUSP_REPORT_SHARING_NATIVE_LIVE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeEval } from '../libs/generic/tauri-verify/src/bridge-client';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import { verifyVerifierSourceSync } from '../packages/operator-core/lib/verifier-source';
import { checkNativeLedger, nativeLedgerEnvironment } from './tauri-surface-verify-reports.mts';

export async function runReportSharingNativeAcceptance() {
  assert.equal(process.env.PAPERCUSP_REPORT_SHARING_NATIVE_LIVE, '1', 'Explicit fixture publication opt-in required');
  // Publication is allowed only in disposable app state. Any explicit account
  // profile must retain the standard verifier's credential and CLI write guards.
  assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Use the isolated native verifier for fixture writes');
  assert.ok(process.env.VERIFY_TAURI_SOURCE_RECEIPT && process.env.OPERATOR_SOURCE_ROOT);
  const sourceRoot = realpathSync(process.env.OPERATOR_SOURCE_ROOT);
  const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'utf8'));
  const test = 'packages/operator-core/lib/report-sharing-native.e2e.test.ts';
  assert.equal(receipt.schemaVersion, 'verifier-source-v1');
  assert.equal(receipt.sourceCommit, process.env.VERIFY_TAURI_SOURCE_REF);
  assert.ok(receipt.files.some((entry: { path: string }) => entry.path === test));
  verifyVerifierSourceSync(sourceRoot, receipt, { runtimeArtifacts: true });
  checkNativeLedger(sourceRoot);
  const tauriPID = Number(process.env.VERIFY_TAURI_PID);
  assert.ok(Number.isSafeInteger(tauriPID) && tauriPID > 0);
  const nativeTmpDir = tmpdir();
  const bridge = JSON.parse(readFileSync(join(nativeTmpDir, `tauri-dev-bridge-${tauriPID}.token`), 'utf8'));
  assert.equal(bridge.pid, tauriPID);
  const authenticated = await bridgeEval({ tauriPID, bridgePort: bridge.port, bridgeToken: bridge.token }, 'true');
  assert.equal(authenticated.ok, true);
  const profileDir = mkdtempSync(join(nativeTmpDir, 'report-sharing-native-profile-'));
  const profilePath = join(profileDir, 'profile.json');
  const evidencePath = process.env.PAPERCUSP_REPORT_SHARING_NATIVE_EVIDENCE;
  assert.ok(evidencePath?.startsWith('/'), 'Preserve recovery and result evidence outside the source snapshot');
  writeFileSync(profilePath, JSON.stringify({ tauriPID, nativeTmpDir,
    runtimeUnits: [`verify-tauri-headless:${tauriPID}`], requiredEnv: [
      'PAPERCUSP_REPORT_SHARING_NATIVE_LIVE', 'PAPERCUSP_REPORT_SHARING_NATIVE_EVIDENCE',
    ] }), { mode: 0o600 });
  try {
    const env = { ...nativeLedgerEnvironment(), PAPERCUSP_TEST_RUN_COMMIT: receipt.sourceCommit,
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: profilePath };
    const selection = process.env.PAPERCUSP_REPORT_SHARING_FINAL_RELEASE === '1'
      ? [] : ['--', '-t', 'shares the selected harmless edition'];
    execFileSync('npm', ['run', 'test:file', '--', test, ...selection], { cwd: sourceRoot, env,
      stdio: 'inherit', timeout: 360_000 });
    verifyVerifierSourceSync(sourceRoot, receipt, { runtimeArtifacts: true });
    console.log('REPORT_SHARING_NATIVE_COMPLETE evidence=' + evidencePath);
  } finally { rmSync(profileDir, { recursive: true, force: true }); }
}

if (isCliEntry(import.meta.url)) await runReportSharingNativeAcceptance();
