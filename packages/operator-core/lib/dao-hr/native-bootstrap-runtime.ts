import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ExecFileOptionsWithStringEncoding, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { killSpawnedProcessTree } from '../../../../scripts/lib/batch-watchdog.mjs';

// Separate preparation from native acceptance. The retained cold run spent
// 19 minutes preparing and two booting before it could start the journey.
export const NATIVE_VERIFIER_PHASE_BUDGETS = { prepare: 25 * 60_000, boot: 10 * 60_000, assert: 10 * 60_000 };
export const NATIVE_BOOTSTRAP_TEARDOWN_MS = 60_000;
export const NATIVE_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000
  + Object.values(NATIVE_VERIFIER_PHASE_BUDGETS).reduce((sum, value) => sum + value, 0)
  + NATIVE_BOOTSTRAP_TEARDOWN_MS;

const execNativeFile = promisify(execFile);

/** Bind the retained native evidence to independently downloaded provider artifacts. */
export function nativeContractEvidence(input: {
  envelopeId: string; storedDocumentHash: string | null; storedDocument: Uint8Array | null;
  storedCertificate: Uint8Array | null; providerDocument: Uint8Array; providerCertificate: Uint8Array;
}) {
  assert.ok(input.envelopeId.trim(), 'Native evidence requires the Documenso envelope identity');
  const digest = (bytes: Uint8Array | null) => {
    assert.ok(bytes && bytes.length >= 8 && Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-',
      'Native evidence requires a stored and provider PDF artifact');
    return '0x' + createHash('sha256').update(bytes).digest('hex');
  };
  const providerHash = digest(input.providerDocument);
  assert.equal(input.storedDocumentHash, providerHash, 'Stored document hash differs from Documenso PDF');
  assert.equal(digest(input.storedDocument), providerHash, 'Stored document bytes differ from Documenso PDF');
  const certificateHash = digest(input.storedCertificate);
  // Certificates can be rendered again by the provider; retain both observed
  // hashes without imposing document-byte identity on that separate artifact.
  const providerCertificateHash = digest(input.providerCertificate);
  return {
    documensoEnvelopeId: input.envelopeId,
    // The maintained Envelope API identifies its certificate by this resource
    // path; it does not issue a separate certificate-id field.
    auditCertificateId: '/api/v2/envelope/' + encodeURIComponent(input.envelopeId) + '/certificate/download',
    auditCertificateIdentityKind: 'provider-resource-path' as const,
    auditCertificateSha256: certificateHash,
    providerAuditCertificateSha256: providerCertificateHash,
    documentHash: { stored: input.storedDocumentHash, provider: providerHash },
  };
}

/** Let HTTP socket-close events and idle timers run while the desktop command waits. */
export async function runNativeCommand(command: string, args: string[], options: ExecFileOptionsWithStringEncoding): Promise<string> {
  const { stdout } = await execNativeFile(command, args, options);
  return stdout;
}

/** Native navigate acknowledges location assignment, before the new document boots. */
export async function reloadNativeWorkbench(native: (...args: string[]) => Promise<string>,
  retain: (diagnostic: { phase: string; state?: { documentReplaced: boolean; routerReady: boolean; workspaceReady: boolean }; captureUnavailable?: true }) => void): Promise<void> {
  const marker = JSON.stringify(randomUUID());
  const state = `({documentReplaced:window.__DAO_HR_RELOAD_MARKER__!==${marker},routerReady:typeof window.__TSR_ROUTER__?.navigate==='function',workspaceReady:!!document.querySelector('[data-testid=dao-workspace]')})`;
  let phase = 'reload-mark';
  try {
    const url = JSON.parse(await native('eval', `JSON.stringify((window.__DAO_HR_RELOAD_MARKER__=${marker},location.href))`)) as string;
    phase = 'reload-navigate';
    await native('navigate', url, '--json');
    phase = 'reload-ready';
    // A ready router in the outgoing document must not satisfy this barrier.
    await native('wait', '--eval', `(()=>{const s=${state};return s.documentReplaced&&s.routerReady&&s.workspaceReady})()`,
      '--timeout', '60000', '--interval', '500');
  } catch (error) {
    let diagnostic: { state?: { documentReplaced: boolean; routerReady: boolean; workspaceReady: boolean }; captureUnavailable?: true };
    try { diagnostic = { state: JSON.parse(await native('eval', 'JSON.stringify(' + state + ')')) }; }
    catch { diagnostic = { captureUnavailable: true }; }
    retain({ phase, ...diagnostic });
    throw error;
  }
}

/** Classify the whole HTTP operation, including body reads, without retaining URLs or secrets. */
export async function nativeHttpPhase<T>(phase: 'wallet-rpc' | 'provider-completion-webhook' | 'sealed-document' | 'audit-certificate',
  action: () => Promise<T>, retain: (diagnostic: { phase: string; errorCode: string }) => void): Promise<T> {
  try { return await action(); }
  catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const code = (cause && typeof cause === 'object' && 'code' in cause ? cause.code :
      error && typeof error === 'object' && 'code' in error ? error.code : undefined);
    const errorCode = ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR']
      .find(known => known === code) ?? 'unclassified';
    retain({ phase, errorCode });
    throw new Error('Native HTTP phase failed: ' + phase + '; errorCode=' + errorCode);
  }
}

/** Retain only assertion snapshots; config and provider sessions stay in private scratch. */
export function retainNativeDiagnostics(resultPath: string, logPath: string) {
  const retained: Array<{ suffix: string; status: 'retained' | 'skipped' | 'error'; path?: string; reason?: string }> = [];
  for (const suffix of ['.text-failure.json', '.response-failure.json', '.wallet-render-failure.json',
    '.completion-response.json', '.control-failure.json', '.http-failure.json', '.navigation-failure.json']) {
    let input: number | undefined, output: number | undefined;
    try {
      input = openSync(resultPath + suffix, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(input);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        retained.push({ suffix, status: 'skipped', reason: !stat.isFile() ? 'not-regular-file' : 'exceeds-1MiB' });
        continue;
      }
      const path = logPath + suffix;
      output = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      fchmodSync(output, 0o600);
      writeFileSync(output, readFileSync(input));
      retained.push({ suffix, status: 'retained', path });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') retained.push({ suffix, status: 'error', reason: code || 'retention-failed' });
    } finally {
      if (output !== undefined) closeSync(output);
      if (input !== undefined) closeSync(input);
    }
  }
  return retained;
}

/** Establish attribution before source preparation or provider allocation. */
export function nativeBootstrapEnvironment(env: NodeJS.ProcessEnv, ledgerUrl: string): NodeJS.ProcessEnv {
  const workspace = env.PAPERCUSP_TEST_RUN_WORKSPACE || env.PAPERCUSP_WORKSPACE_ID || env.PAPERCUSP_WORKSPACE;
  assert.ok(workspace?.trim(), 'PAPERCUSP_TEST_RUN_WORKSPACE is required before native allocation');
  assert.ok(ledgerUrl.trim(), 'PAPERCUSP_TEST_RUNS_DB_URL is required before native allocation');
  return { ...env, PAPERCUSP_TEST_RUNS_DB_URL: ledgerUrl, PAPERCUSP_TEST_RUN_WORKSPACE: workspace,
    PAPERCUSP_TEST_RUN_GROUP: env.PAPERCUSP_TEST_RUN_GROUP?.trim() || `dao-hr-native-${randomUUID()}` };
}

/** Join the whole verifier tree before fixtures can be torn down or a test can finish. */
export async function runNativeVerifier(command: string, args: string[], options: SpawnOptions & {
  signal: AbortSignal; timeoutMs: number; killGraceMs?: number;
  phaseBudgetsMs?: typeof NATIVE_VERIFIER_PHASE_BUDGETS; logFd?: number;
}): Promise<number | null> {
  const { signal, timeoutMs, killGraceMs = 30_000, phaseBudgetsMs, logFd, ...spawnOptions } = options;
  signal.throwIfAborted();
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0,
    'Native bootstrap exhausted its preparation budget before verifier launch');
  assert.ok(Number.isFinite(killGraceMs) && killGraceMs >= 0, 'Native verifier kill grace must be finite and nonnegative');
  if (phaseBudgetsMs) {
    assert.ok(Number.isInteger(logFd), 'Native phase budgets require retained output');
    for (const budget of Object.values(phaseBudgetsMs))
      assert.ok(Number.isFinite(budget) && budget > 0, 'Native phase budgets must be positive and finite');
  }
  const child = spawn(command, args, { ...spawnOptions, detached: true,
    ...(logFd === undefined ? {} : { stdio: ['ignore', 'pipe', 'pipe'] }) });
  let failure: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  let phaseDeadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: Error) => {
    if (failure) return;
    failure = reason;
    killSpawnedProcessTree(child, 'SIGTERM');
    termination = new Promise(resolve => {
      escalation = setTimeout(() => { killSpawnedProcessTree(child, 'SIGKILL'); resolve(); }, killGraceMs);
    });
  };
  const abort = () => stop(new Error('Native verifier cancelled with its enclosing test', { cause: signal.reason }));
  const phases = ['prepare', 'boot', 'assert'] as const;
  let phaseIndex = -1;
  const enterPhase = (index: number) => {
    if (!phaseBudgetsMs || index <= phaseIndex) return; // Repeated progress cannot renew a deadline.
    phaseIndex = index;
    clearTimeout(phaseDeadline);
    const phase = phases[index];
    phaseDeadline = setTimeout(() => stop(new Error(`Native verifier ${phase} phase exceeded its ${phaseBudgetsMs[phase]}ms budget`)), phaseBudgetsMs[phase]);
  };
  const readers: ReturnType<typeof createInterface>[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream || logFd === undefined) continue;
    stream.on('data', chunk => writeSync(logFd, chunk));
    const lines = createInterface({ input: stream });
    lines.on('line', line => {
      const phase = line.match(/^VH_BEGIN phase=(prepare|boot|assert)$/)?.[1];
      if (phase) enterPhase(phases.indexOf(phase as typeof phases[number]));
    });
    readers.push(lines);
  }
  enterPhase(0); // Also bounds preflight before the shell emits its first marker.
  const deadline = setTimeout(() => stop(new Error(`Native verifier exceeded its remaining ${timeoutMs}ms budget`)), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => failure ? reject(failure) : resolve(code));
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(phaseDeadline);
    for (const reader of readers) reader.close();
    signal.removeEventListener('abort', abort);
    // A shell can exit on SIGTERM while a descendant ignores it. Direct-child
    // close must not cancel group escalation or let fixture teardown run early.
    await termination;
    if (escalation) clearTimeout(escalation);
  }
}
