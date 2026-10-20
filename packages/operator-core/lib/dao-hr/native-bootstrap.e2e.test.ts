/** Configures external fixtures BEFORE the owned native host boots. Run with the maintained Documenso sandbox. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { prepareIdentityFixture, installIdentityFixture } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { startDaoHrTestChain } from '../../../../scripts/fixtures/dao-hr-test-chain';
import { startDaoHrWalletBindingFixture } from './wallet-binding-fixture';
import { register, authenticatedAccount, accountToken } from '../../../../scripts/fixtures/dao-hr-documenso-ui';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';
import { prepareVerifierSource, prepareVerifierDependencies, verifyVerifierSource, verifierSourceChildEnv } from '../../../../scripts/source-preview.mjs';
import { checkNativeLedger } from '../../../../scripts/tauri-surface-verify-reports.mts';
import { nativeBootstrapEnvironment, runNativeVerifier, retainNativeDiagnostics, nativeBootstrapBudgets,
  assertNativeMutationProof, NATIVE_BOOTSTRAP_TEARDOWN_MS } from './native-bootstrap-runtime';
import { assertNativeHireResult } from './native-hire-result';

const NATIVE_SOURCE_INPUTS = [
  'packages/operator-core/lib/dao-hr/native-bootstrap.e2e.test.ts',
  'packages/operator-core/lib/dao-hr/native.e2e.test.ts',
  'packages/operator-core/lib/dao-hr/native-bootstrap-runtime.ts',
  'packages/operator-core/lib/dao-hr/native-hire-result.ts',
  'scripts/tauri-surface-verify-dao-hr.mts', 'scripts/fixtures/dao-hr-documenso-ui.ts',
  'scripts/fixtures/dao-hr-test-chain.ts', 'scripts/fixtures/dao-hr-wallet-binding.ts',
  'scripts/fixtures/dao-hr-wallet-binding-contract.ts', 'packages/operator-core/lib/dao-hr/wallet-binding-fixture.ts',
  'scripts/lib/dao-workbench-controls.mts', 'packages/operator-core/lib/dao-finance.ts',
  'scripts/fixtures/dao-workbench-identity.mjs',
  'scripts/lib/batch-watchdog.mjs', 'scripts/lib/verify-tauri-assertion-env.mjs',
  'scripts/tauri-surface-verify-reports.mts', 'scripts/source-preview.mjs',
  'scripts/mutation-probe.sh', 'scripts/mutation-probe-admission.sh',
  'scripts/mutation-probe-window-gate.mjs', 'scripts/lib/mutation-probe-window.mjs',
  'libs/test-config/src/admin-test-runs-reporter.ts', 'libs/test-config/src/verifier-source.ts',
  'libs/test-config/src/mutation-descriptor.ts',
  'scripts/with-documenso-sandbox.mjs',
];

describe.skipIf(process.env.PAPERCUSP_DAO_HR_NATIVE !== '1')('P012 combined native hire bootstrap', () => {
  it('runs the isolated native hire journey with actual provider accounts, hosted wallet routes and signed V2 chain', async ({ onTestFinished }) => {
    const budgets = nativeBootstrapBudgets(process.env);
    const verifierDeadline = Date.now() + budgets.timeoutMs - NATIVE_BOOTSTRAP_TEARDOWN_MS;
    const cancellation = new AbortController();
    let verifier: Promise<number | null> | undefined;
    onTestFinished(async () => {
      cancellation.abort();
      await verifier?.catch(() => {}); // The original rejection remains the test's failure.
    });
    expect(Boolean(process.env.DOCUMENSO_TEST_RUNTIME)).toBe(true);
    const runtime = JSON.parse(process.env.DOCUMENSO_TEST_RUNTIME!);
    expect(runtime).toMatchObject({ isolatedDatabase: true, externalMail: false, testCertificate: true });
    const root = resolve(import.meta.dirname, '../../../..');
    const env = nativeBootstrapEnvironment(process.env,
      process.env.PAPERCUSP_TEST_RUNS_DB_URL || resolveExecutedMapPgUrl().url);
    env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
    env.PAPERCUSP_REPO_DIR = process.env.PAPERCUSP_REPO_DIR || root;
    checkNativeLedger(root, env);
    const directory = mkdtempSync(join(tmpdir(), 'dao-hr-native-'));
    let sourceDirectory: string | undefined;
    const evidenceRoot = '/tmp/pcv/dao-hr-native'; mkdirSync(evidenceRoot, { recursive: true });
    const logPath = process.env.DAO_HR_NATIVE_BOOT_LOG || join(evidenceRoot, 'native-boot-' + Date.now() + '.log');
    const priorIsolation = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    let restoreIdentity: (() => void) | undefined;
    let chain: Awaited<ReturnType<typeof startDaoHrTestChain>> | undefined;
    let wallet: Awaited<ReturnType<typeof startDaoHrWalletBindingFixture>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      // Freeze the invoked wrapper and acceptance helpers before any external
      // allocation. A preflight of the mutable donor alone leaves a boot-time race.
      // The maintained dependency snapshot uses hardlinks. Provider TMPDIR can
      // be on another device, so own this source tree on the donor filesystem.
      const sourceRef = process.env.VERIFY_TAURI_SOURCE_REF?.trim();
      expect(Boolean(sourceRef), 'Explicit committed VERIFY_TAURI_SOURCE_REF is required').toBe(true);
      let sourceRoot: string;
      let receipt: Awaited<ReturnType<typeof prepareVerifierSource>>;
      let receiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
      if (receiptPath) {
        // The outer verifier freezes the provider wrapper too; reuse its root.
        sourceRoot = root;
        Object.assign(env, verifierSourceChildEnv({ root, receiptPath, env }));
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        expect(receipt.sourceCommit).toBe(sourceRef);
        for (const input of NATIVE_SOURCE_INPUTS)
          expect(receipt.testedInputs.some(row => row.path === input), 'Missing invoked input: ' + input).toBe(true);
      } else {
        const sourceScratch = join(root, '.papercusp', 'scratch');
        mkdirSync(sourceScratch, { recursive: true });
        sourceDirectory = mkdtempSync(join(sourceScratch, 'dao-hr-native-source-'));
        expect(statSync(sourceDirectory).dev, 'Invoked source must share the dependency donor filesystem').toBe(statSync(root).dev);
        sourceRoot = join(sourceDirectory, 'invoked-source');
        receipt = await prepareVerifierSource({ repo: root, ref: sourceRef!, dest: sourceRoot,
          inputs: NATIVE_SOURCE_INPUTS, tauriInputs: true, gitCheckout: true });
        receiptPath = logPath + '.invoked-source-receipt.json';
        writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
        await prepareVerifierDependencies({ donor: root, dest: sourceRoot, receipt });
        Object.assign(env, verifierSourceChildEnv({ root: sourceRoot, receiptPath, env }));
      }
      cancellation.signal.throwIfAborted();
      writeFileSync(logPath + '.invoked-source-receipt.json', JSON.stringify(receipt), { mode: 0o600 });
      env.PAPERCUSP_REPO_DIR = sourceRoot;
      env.VERIFY_TAURI_SOURCE_REF = receipt.sourceCommit;
      env.VERIFY_TAURI_SOURCE_INPUTS = NATIVE_SOURCE_INPUTS.join(',');
      const identityPath = prepareIdentityFixture(directory);
      const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
      env.DAO_WORKBENCH_IDENTITY_FIXTURE = identityPath;
      restoreIdentity = installIdentityFixture(identity, env);
      process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
      browser = await chromium.launch({ headless: true });
      cancellation.signal.throwIfAborted();
      chain = await startDaoHrTestChain();
      cancellation.signal.throwIfAborted();
      wallet = await startDaoHrWalletBindingFixture();
      cancellation.signal.throwIfAborted();
      const candidate = await register(browser, { personId: 'PER-native-candidate', name: 'Native candidate', email: identity.actors.candidate.email });
      cancellation.signal.throwIfAborted();
      const company = await register(browser, { personId: 'PER-native-approver', name: 'Native countersigner', email: identity.actors.approver.email });
      cancellation.signal.throwIfAborted();
      await authenticatedAccount(company.page, identity.actors.approver.email);
      env.DOCUMENSO_API_KEY = await accountToken(company.page);
      env.DOCUMENSO_WEBHOOK_SECRET = randomBytes(32).toString('hex');
      env.PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL = chain.url; env.PAPERCUSP_CUPBOARD_URL = wallet.url;
      const candidateSession = join(directory, 'candidate-provider.json'), companySession = join(directory, 'company-provider.json');
      await candidate.context.storageState({ path: candidateSession }); await company.context.storageState({ path: companySession });
      const configPath = join(directory, 'native-config.json');
      writeFileSync(configPath, JSON.stringify({ rpc: chain.url, accounts: chain.accounts,
        equity: chain.equity.address, governor: chain.governor.address, timelock: chain.timelock.address,
        candidateSession, companySession, resultPath: join(directory, 'result.json') }), { mode: 0o600 });
      env.DAO_HR_NATIVE_CONFIG = configPath;
      await verifyVerifierSource(sourceRoot, receipt, { runtimeArtifacts: true });
      const fd = openSync(logPath, 'w', 0o600);
      let code: number | null;
      try {
        verifier = runNativeVerifier('bash', [join(sourceRoot, 'scripts/verify-tauri-headless.sh'), '--', 'node', '--import', 'tsx',
          join(sourceRoot, 'scripts/tauri-surface-verify-dao-hr.mts')], { cwd: sourceRoot,
          signal: cancellation.signal, timeoutMs: verifierDeadline - Date.now(),
          phaseBudgetsMs: budgets.phaseBudgetsMs, logFd: fd,
          env: { ...env, VERIFY_TAURI_ISOLATED_DB: '1', VERIFY_TAURI_ISOLATED_SEED: 'ready', VERIFY_TAURI_WINDOW: '1440x1000',
            NODE_OPTIONS: (env.NODE_OPTIONS || '') + ' --import=' + join(sourceRoot, 'scripts/fixtures/dao-workbench-identity.mjs') },
          stdio: ['ignore', fd, fd] });
        code = await verifier;
      } finally { closeSync(fd); }
      expect(code, 'Native boot/journey log: ' + logPath).toBe(0);
      if (env.PAPERCUSP_DAO_HR_NATIVE_MUTATION === '1') {
        const proof = assertNativeMutationProof(readFileSync(logPath, 'utf8'));
        writeFileSync(logPath + '.mutation.json', JSON.stringify(proof), { mode: 0o600 });
        console.log('DAO_HR_NATIVE_MUTATION_RESULT=' + JSON.stringify(proof));
        return;
      }
      const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
      assertNativeHireResult(result);
      writeFileSync(logPath + '.result.json', JSON.stringify(result), { mode: 0o600 });
      console.log('DAO_HR_NATIVE_RESULT=' + JSON.stringify(result));
    } finally {
      retainNativeDiagnostics(join(directory, 'result.json'), logPath);
      await browser?.close(); await wallet?.stop(); await chain?.stop(); restoreIdentity?.();
      if (priorIsolation === undefined) delete process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
      else process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = priorIsolation;
      if (sourceDirectory) rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }, nativeBootstrapBudgets(process.env).timeoutMs);
});
