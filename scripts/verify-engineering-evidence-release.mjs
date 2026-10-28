import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { admitTaskDeadline, readTaskDeadlineEpochMs } from './lib/task-deadline.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const writePhaseFile = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
export const ENGINEERING_RELEASE_BUDGET_MS = 45 * 60_000;
export const CURRENT_ENGINEERING_TEST_FILES = [
  'packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts',
  'packages/operator-core/lib/code-intelligence/engineering-evidence-rename.integration.test.ts',
  'packages/operator-core/lib/observability/runtime.integration.test.ts',
  'apps/operator-vite/src/routes/plans.test.tsx',
];
/** Fresh execution plus an exact browser artifact; saved passes and missing inputs are UNKNOWN. */
export function verifyEngineeringRelease({ root, inputsPath, env = process.env, run = spawnSync, read = readFileSync,
  write = writePhaseFile,
  nonce = randomUUID(), plane = 'final-release', now = Date.now }) {
  const scope = `native-engineering-evidence-${plane}-v1`;
  const phases = {};
  let integration;
  const unknown = reason => ({ scope, status: 'unknown', reason, phases, ...(integration ? { integration } : {}) });
  if (!['current-build', 'final-release'].includes(plane)) return unknown('Unknown engineering evidence plane.');
  let bytes, input;
  try { bytes = read(inputsPath); input = JSON.parse(String(bytes)); }
  catch { return unknown('Canonical release journey inputs are unavailable.'); }
  if (!input || typeof input !== 'object' || !input.workspaceId || !input.clientId
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.buildSha ?? '') || (plane === 'final-release' && !input.promotionReceipt))
    return unknown('A full promoted artifact and authoritative promotion receipt are required.');
  const manifestSha256 = digest(bytes);
  const runDir = join(dirname(inputsPath), 'runs', nonce);
  // Share one launch clock across integration, native preparation and assertions.
  // Without a launcher clock, preserve the former combined 30m + 15m ceiling.
  const deadlineEpochMs = Math.min(readTaskDeadlineEpochMs(env) ?? Infinity, now() + ENGINEERING_RELEASE_BUDGET_MS);
  // Keep diagnostics even when a child fails before it can emit a proof. Never
  // serialize its environment: the child inherits authentication credentials.
  const retainPhase = (phase, child) => {
    const liveStdoutPath = join(runDir, phase + '.stdout.log');
    const liveStderrPath = join(runDir, phase + '.stderr.log');
    const stdout = child.stdout == null ? readFileSync(liveStdoutPath, 'utf8') : String(child.stdout);
    const stderr = child.stderr == null ? readFileSync(liveStderrPath, 'utf8') : String(child.stderr);
    const stdoutPath = join(runDir, `${phase}.stdout.log`), stderrPath = join(runDir, `${phase}.stderr.log`);
    const metadataPath = join(runDir, `${phase}.json`);
    const error = child.error ? { name: child.error.name ?? 'Error', message: String(child.error.message ?? child.error),
      ...(child.error.code ? { code: child.error.code } : {}) } : null;
    const metadata = { phase, plane, nonce, buildSha: input.buildSha, manifestSha256,
      status: child.status ?? null, signal: child.signal ?? null, error,
      stdoutPath, stderrPath, stdoutSha256: digest(stdout), stderrSha256: digest(stderr) };
    write(stdoutPath, stdout); write(stderrPath, stderr);
    write(metadataPath, JSON.stringify(metadata));
    phases[phase] = { ...metadata, metadataPath };
    return { stdout, stderr };
  };
  const childEnv = { ...env, PAPERCUSP_WORKSPACE: input.workspaceId, PAPERCUSP_SID: env.PAPERCUSP_SID ?? input.clientId,
    PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(deadlineEpochMs),
    PAPERCUSP_ENGINEERING_PLANE: plane, PAPERCUSP_ENGINEERING_JOURNEY_INPUTS: inputsPath,
    PAPERCUSP_ENGINEERING_JOURNEY_NONCE: nonce, OPERATOR_E2E_BASE_URL: `http://127.0.0.1:${plane === 'final-release' ? 3070 : 3170}`,
    PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_ENGINEERING_JOURNEY_OUTPUT: join(runDir, 'tauri'),
    VERIFY_TAURI_SOURCE_REF: input.buildSha, VERIFY_TAURI_ISOLATED_DB: '0',
    VERIFY_TAURI_SOURCE_INPUTS: [...(input.sourcePins?.map(pin => pin.path) ?? []),
      'scripts/verify-engineering-evidence-tauri.mjs', 'scripts/verify-engineering-evidence-release.mjs',
      'apps/operator/e2e/_engineering-evidence-journey-config.ts', 'apps/operator/e2e/_plan-audit-release-config.ts'].join(',') };
  const phaseBudget = () => {
    const nowMs = now();
    const budget = admitTaskDeadline({ env: childEnv, nowMs });
    return { timeout: budget.childCutoffEpochMs - nowMs,
      env: { ...childEnv, PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(budget.childCutoffEpochMs) } };
  };
  // With the production file sink, give the child the nonce log files directly.
  // The kernel then exposes output as it is written, even while spawnSync is still
  // waiting for a long or stalled phase. Injected sinks keep the existing in-memory
  // test seam; retainPhase still applies the same hashes and fail-closed contract.
  const runPhase = (phase, command, args, options) => {
    if (write !== writePhaseFile) {
      const child = run(command, args, options);
      return { ...child, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
    }
    mkdirSync(runDir, { recursive: true });
    const stdoutPath = join(runDir, phase + '.stdout.log');
    const stderrPath = join(runDir, phase + '.stderr.log');
    let stdoutFd, stderrFd, child;
    try {
      stdoutFd = openSync(stdoutPath, 'w');
      stderrFd = openSync(stderrPath, 'w');
      child = run(command, args, { ...options, stdio: ['ignore', stdoutFd, stderrFd] });
    } catch (error) {
      child = { status: null, signal: null, stdout: null, stderr: null, error };
    } finally {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
    try {
      // spawnSync enforces maxBuffer for pipes, but not when output is sent to
      // regular files. Reapply the same per-stream byte ceiling before reading
      // retained output, and fail closed when either stream exceeded it.
      const maxBuffer = Math.max(0, Math.floor(options.maxBuffer ?? 1024 * 1024));
      const stdoutBytes = statSync(stdoutPath).size;
      const stderrBytes = statSync(stderrPath).size;
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        if (stdoutBytes > maxBuffer) truncateSync(stdoutPath, maxBuffer);
        if (stderrBytes > maxBuffer) truncateSync(stderrPath, maxBuffer);
        return { ...child, status: null,
          error: Object.assign(new Error(`spawnSync ${command} ENOBUFS`), { code: 'ENOBUFS' }) };
      }
    } catch (error) {
      return { ...child, status: null, stdout: null, stderr: null, error };
    }
    return child;
  };
  let budget;
  if (plane === 'current-build') {
    // Retain the original canonical integration promise and add the true rename,
    // instrumented execution and actual UI detectors. The existing PG wrapper
    // owns a throwaway server and cleans it; it never borrows product data.
    try { budget = phaseBudget(); }
    catch (error) { return unknown(String(error.message)); }
    const tests = runPhase('integration', process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--',
      'npm', 'run', 'lint:as-committed', '--', 'test:file', `--ref=${input.buildSha}`, '--any', '--keep', '--',
      ...CURRENT_ENGINEERING_TEST_FILES], {
      cwd: root, ...budget, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    let retained;
    try { retained = retainPhase('integration', tests); }
    catch { return unknown('The integration phase diagnostics could not be retained.'); }
    const result = retained.stdout.split(/\r?\n/).filter(line => line.startsWith('TEST_FILE_RESULT ')).at(-1);
    const logPath = join(runDir, 'canonical-integration.log');
    const output = retained.stdout + '\n' + retained.stderr;
    try { write(logPath, output); } catch { return unknown('The integration receipt could not be retained.'); }
    if (tests.error || tests.signal || tests.status !== 0 || !result
      || !result.includes('requested=4 executed=4 matched=4 status=passed')
      || !result.includes('uncommittedPaths=0/4') || !result.includes('childSubstituted=0') || !result.includes('skippedTests=0'))
      return unknown('Current-build integration/UI detectors lack a complete clean-source, no-skip framework receipt.');
    integration = { logPath, sha256: digest(output), result, files: CURRENT_ENGINEERING_TEST_FILES };
  }
  try { budget = phaseBudget(); }
  catch (error) { return unknown(String(error.message)); }
  const child = runPhase('browser', 'bash', [join(root, 'scripts/verify-tauri-headless.sh'), '--',
    'bash', '-c', 'exec node --import tsx "$OPERATOR_SOURCE_ROOT/scripts/verify-engineering-evidence-tauri.mjs"'], {
    cwd: root, ...budget, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  let retainedBrowser;
  try { retainedBrowser = retainPhase('browser', child); }
  catch { return unknown('The browser phase diagnostics could not be retained.'); }
  if (child.error || child.signal || child.status !== 0) return unknown('The maintained release browser journey did not complete successfully.');
  const line = retainedBrowser.stdout.split(/\r?\n/).find(line => line.startsWith('ENGINEERING_EVIDENCE_JOURNEY_VERIFIED '));
  if (!line) return unknown('No fresh completed browser receipt was emitted.');
  try {
    const proof = JSON.parse(line.slice('ENGINEERING_EVIDENCE_JOURNEY_VERIFIED '.length));
    if (proof.plane !== plane || proof.buildSha !== input.buildSha || proof.manifestSha256 !== manifestSha256
      || proof.nonce !== nonce || !/^[a-f0-9]{64}$/.test(proof.receiptSha256 ?? '') || !proof.receiptPath)
      return unknown('The browser receipt belongs to another artifact, plane, manifest or invocation.');
    const receiptBytes = read(proof.receiptPath), receipt = JSON.parse(String(receiptBytes));
    if (digest(receiptBytes) !== proof.receiptSha256 || receipt.driver !== 'tauri-agent-tools' || receipt.nonce !== nonce || receipt.plane !== plane
      || receipt.buildSha !== input.buildSha || receipt.manifestSha256 !== manifestSha256)
      return unknown('The exact emitted browser artifact could not be verified.');
    return { scope, status: 'pass', plane, buildSha: input.buildSha, manifestSha256,
      receiptPath: proof.receiptPath, receiptSha256: proof.receiptSha256, nonce, phases, ...(integration ? { integration } : {}) };
  } catch { return unknown('The emitted browser artifact is missing or malformed.'); }
}

async function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const plane = process.argv[3] ?? 'final-release';
  const inputsPath = process.env.PAPERCUSP_ENGINEERING_JOURNEY_INPUTS
    ?? join(process.env.PAPERCUSP_HOME ?? join(homedir(), '.papercusp'), 'verification',
      plane === 'final-release' ? 'native-engineering-evidence-release-inputs.json' : 'native-engineering-evidence-current-inputs.json');
  // The verification-harness contract (contract-lint R-10): the run is recorded under the shared
  // evidence root. stdout and the exit code are unchanged: the JSON verdict prints exactly as
  // before, and a throw still fails the process instead of being absorbed by the harness.
  const { defaultEvidenceRoot, runHarness } = await import('@papercusp/verification-harness');
  let thrown = null;
  await runHarness({
    contract: { name: 'engineering-evidence-release', phases: [{ id: 'verify' }] },
    evidenceRoot: defaultEvidenceRoot('engineering-evidence-release'),
    async runPhase(ctx) {
      ctx.markStep(`verify-${plane}`);
      try {
        const verdict = verifyEngineeringRelease({ root, inputsPath, plane });
        console.log(JSON.stringify(verdict));
        return verdict?.status === 'pass' ? { ok: true } : { ok: false, reasonCode: `verdict-${verdict?.status ?? 'missing'}` };
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
  });
  if (thrown) throw thrown;
}

// This entry also belongs to the host bundle graph. Keep the harness awaits
// inside a function so esbuild never gives its importers an async module init.
if (isCliEntry(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
