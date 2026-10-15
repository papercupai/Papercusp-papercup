/** Reports Library: real publish tool -> SSE list -> exact native Markdown/Mermaid reader. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,PAPERCUSP_TEST_RUN_GROUP
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { bridgeEval } from '../libs/generic/tauri-verify/src/bridge-client';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import { verifyVerifierSourceSync } from '../packages/operator-core/lib/verifier-source';

export interface NativeLiveProfile {
  tauriPID: number;
  nativeTmpDir: string;
  workspaceId: string;
  nativeChildren?: { script: string; bundle: string; sha256: string }[];
}

/** Exercise the same clear-filter action in native verification and the real DOM regression. */
export function reportsClearFiltersExpression(): string {
  return `(() => {
    const buttons = Array.from(document.querySelectorAll('.reports-filter-controls button'))
      .filter(button => button.textContent?.trim() === 'Clear filters');
    if (buttons.length !== 1) throw new Error('Expected one Clear filters button in the Reports filter controls');
    buttons[0].click();
    return true;
  })()`;
}

/** Keep the native history/filter witness testable against the real Reports DOM. */
export function reportsHistoryFilterExpression(expected: {
  originalTitle: string; correctedTitle: string; subjectValue: string; subjectLabel: string;
}): string {
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const actual = {
      listCount: document.querySelectorAll('.reports-list-item').length,
      listText: document.querySelector('.reports-list-item')?.textContent ?? null,
      readerTitle: document.querySelector('.reports-reader h2')?.textContent ?? null,
      searchValue: document.querySelector('[aria-label="Search reports"]')?.value ?? null,
      subjectValue: new URL(location.href).searchParams.get('subject'),
      subjectLabel: document.querySelector('.reports-subject-picker')?.textContent ?? null,
      historyCount: document.querySelectorAll('.reports-history-item').length,
    };
    const checks = {
      listCount: actual.listCount === 1,
      correctedEdition: actual.listText?.includes(expected.correctedTitle) === true,
      originalReader: actual.readerTitle === expected.originalTitle,
      searchValue: actual.searchValue === expected.originalTitle,
      subjectUrl: actual.subjectValue === expected.subjectValue,
      subjectLabel: actual.subjectLabel === 'About: ' + expected.subjectLabel + ' ▾',
      historyCount: actual.historyCount === 2,
    };
    window.__reportsHistoryFilterWitness = { expected, actual, checks };
    return Object.values(checks).every(value => value === true);
  })()`;
}

/** Restore only the owned private context after the worker's hermetic scrub. */
export function nativeChildEnvironment(profile: NativeLiveProfile, env = process.env): NodeJS.ProcessEnv {
  assert.equal(env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Use the isolated native verifier');
  assert.ok(Number.isSafeInteger(profile.tauriPID) && profile.tauriPID > 0
    && profile.tauriPID === Number(env.VERIFY_TAURI_PID), 'Native profile PID must match the owned rig');
  assert.ok(typeof profile.workspaceId === 'string' && /^verify-tauri-isolated-\d+$/.test(profile.workspaceId),
    'Native profile requires an explicit private workspace');
  assert.ok(typeof profile.nativeTmpDir === 'string' && isAbsolute(profile.nativeTmpDir),
    'Native profile requires an absolute discovery directory');
  return { ...env, TMPDIR: profile.nativeTmpDir,
    PAPERCUSP_WORKSPACE_ID: profile.workspaceId, PAPERCUSP_WORKSPACE: profile.workspaceId };
}

/** Admit only the postmaster provisioned inside this verifier's private profile. */
export function nativeTestDatabaseEnvironment(profile: NativeLiveProfile, env = process.env): NodeJS.ProcessEnv {
  const privateEnv = nativeChildEnvironment(profile, env);
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1', 'Native test PG must disable shared discovery');
  assert.ok(env.PAPERCUSP_HOME && isAbsolute(env.PAPERCUSP_HOME), 'Native test PG requires a private home');
  const privateHome = realpathSync(env.PAPERCUSP_HOME);
  const work = dirname(privateHome);
  assert.ok(basename(privateHome) === 'papercusp-home' && /^verify-tauri-headless\./.test(basename(work)),
    'Native test PG requires the owned verifier profile');
  const dataDir = realpathSync(join(work, 'isolated-pgdata'));
  assert.equal(dataDir, join(work, 'isolated-pgdata'), 'Native test PG data must remain in its private profile');
  const address = new URL(env.HARNESS_ADMIN_DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(address.protocol)
    && ['localhost', '127.0.0.1'].includes(address.hostname)
    && address.pathname === '/papercusp'
    && !!address.port && address.port !== '5432' && address.port === env.PAPERCUSP_PG_PORT,
    'Native test PG URL must match the private rig');
  const [pidText, recordedDataDir, , port] = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
  const pid = Number(pidText);
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && recordedDataDir === dataDir && port === address.port,
    'Native test PG postmaster identity must match its private data and port');
  process.kill(pid, 0);
  const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  assert.ok(basename(command[0]) === 'postgres' && command.indexOf('-D') > 0
    && command[command.indexOf('-D') + 1] === dataDir,
    'Native test PG requires the live owned postmaster');
  // The integration setup already admits PAPERCUSP_TEST_PG_ADMIN_URL and keeps
  // every other captured ambient target protected. Do not alter that guard.
  return { ...privateEnv, PAPERCUSP_TEST_PG_ADMIN_URL: address.toString() };
}

/** Pin recorder startup policy to its ledger endpoint, never the app's private PG. */
export function nativeLedgerEnvironment(env = process.env): NodeJS.ProcessEnv {
  const ledgerUrl = env.PAPERCUSP_TEST_RUNS_DB_URL;
  assert.ok(ledgerUrl, 'Keep native results in the shared test ledger');
  const address = new URL(ledgerUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(address.protocol), 'Native ledger requires a Postgres URL');
  const poolerPort = Number(env.PAPERCUSP_PGBOUNCER_PORT) || 6432;
  const pooled = ['localhost', '127.0.0.1'].includes(address.hostname)
    && Number(address.port) === poolerPort;
  // Explicit URLs stay exact: a direct or remote endpoint must not be rerouted
  // to this machine's shared pooler. Only its known loopback pooler is pooled.
  const childEnv: NodeJS.ProcessEnv = { ...env, HARNESS_ADMIN_DATABASE_URL: ledgerUrl, DATABASE_URL: ledgerUrl,
    PAPERCUSP_PGBOUNCER: pooled ? '1' : '0' };
  delete childEnv.PAPERCUSP_PG_PORT;
  return childEnv;
}

/** SELECT-only admission check, runnable before allocating the native verifier. */
export function checkNativeLedger(sourceRoot = process.cwd(), env = process.env): void {
  assert.ok(env.PAPERCUSP_TEST_RUN_GROUP?.trim(),
    'Use PAPERCUSP_TEST_RUN_GROUP to retain native ledger attribution before allocation');
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    try { await sql\`SELECT 1\`; }
    finally { await sql.end({ timeout: 2 }); }
  `], { cwd: sourceRoot, stdio: 'inherit', timeout: 10_000, env: nativeLedgerEnvironment(env) });
}

/** Preserve startup stdout/stderr and the original stack in the test failure. */
export function runNativeChild(profile: NativeLiveProfile, sourceRoot: string, script: string, args: string[] = []) {
  const env = nativeChildEnvironment(profile);
  const prepared = profile.nativeChildren?.find(child => child.script === script);
  assert.ok(prepared, 'Native child must be bundled from the verified source before the test starts');
  assert.match(script, /^scripts\/[\w-]+\.mts$/);
  const bundle = join(sourceRoot, 'apps/operator/dist-verify', `native-${basename(script, '.mts')}.mjs`);
  assert.equal(prepared.bundle, bundle, 'Native child bundle must remain in the verified source snapshot');
  assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(readFileSync(bundle)).digest('hex'), prepared.sha256,
    'Prepared native child bundle changed before launch');
  const started = Date.now();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    // Compilation belongs to preparation, outside the bounded native journey.
    // Keep inherited identity/source guards; only the runtime tsx loader goes away.
    execFile(process.execPath, [bundle, ...args], {
      cwd: sourceRoot, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr }); return; }
      reject(new Error(`Native child ${script} failed (workspace=${profile.workspaceId}, pid=${profile.tauriPID}, elapsedMs=${Date.now() - started}, bundleSha256=${prepared.sha256}):\n`
        + `${error.stack ?? error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error }));
    });
  });
}

/** Run with --e2e inside verify-tauri-headless, before Vitest relocates TMPDIR. */
export async function runNativeE2e(testFiles = ['packages/operator-core/lib/reports-library-native.e2e.test.ts'],
  options: { runtimeUnit?: string; nativeScripts?: string[] } = {}) {
  assert.ok(testFiles.length > 0 && testFiles.every(file => /^packages\/operator-core\/lib\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:e2e|integration)\.test\.ts$/.test(file)),
    'Use maintained operator-core native E2E or integration test files');
  assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Use the isolated native verifier');
  assert.ok(process.env.PAPERCUSP_TEST_RUNS_DB_URL, 'Keep native results in the shared test ledger');
  assert.ok(process.env.PAPERCUSP_TEST_RUN_GROUP?.trim(),
    'Use PAPERCUSP_TEST_RUN_GROUP to retain native ledger attribution before allocation');
  const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
  assert.equal(receipt.schemaVersion, 'verifier-source-v1');
  assert.equal(receipt.sourceCommit, process.env.VERIFY_TAURI_SOURCE_REF);
  assert.ok(process.env.OPERATOR_SOURCE_ROOT, 'Use the verifier source snapshot');
  const sourceRoot = realpathSync(process.env.OPERATOR_SOURCE_ROOT);
  verifyVerifierSourceSync(sourceRoot, receipt, { runtimeArtifacts: true });
  assert.ok(testFiles.every(file => receipt.files.some((entry: { path: string }) => entry.path === file)),
    'Native test selection must belong to the verified source snapshot');
  const nativeScripts = options.nativeScripts ?? [];
  assert.ok(new Set(nativeScripts).size === nativeScripts.length && nativeScripts.every(script =>
    /^scripts\/[\w-]+\.mts$/.test(script) && receipt.files.some((entry: { path: string }) => entry.path === script)),
  'Native child selection must belong to the verified source snapshot');
  const tauriPID = Number(process.env.VERIFY_TAURI_PID);
  assert.ok(Number.isSafeInteger(tauriPID) && tauriPID > 0, 'Owned native PID required');
  const nativeTmpDir = tmpdir();
  const profile = { runtimeUnits: [] as string[], nativeChildren: [] as NonNullable<NativeLiveProfile['nativeChildren']>,
    tauriPID, nativeTmpDir, workspaceId: process.env.PAPERCUSP_WORKSPACE_ID! };
  const testEnv = nativeTestDatabaseEnvironment(profile);
  const token = JSON.parse(readFileSync(join(nativeTmpDir, `tauri-dev-bridge-${tauriPID}.token`), 'utf8'));
  assert.equal(token.pid, tauriPID);
  const authenticated = await bridgeEval({ tauriPID, bridgePort: token.port, bridgeToken: token.token }, 'true');
  assert.equal(authenticated.ok, true, authenticated.ok ? undefined : authenticated.error);

  // Reuse the kernel-measured runtime ledger. The recorder captures this
  // executable's identity before and after the entire native test execution.
  const runtimeUnits = [options.runtimeUnit ?? 'reports-library-native-desktop'];
  assert.ok(process.env.PAPERCUSP_TEST_RUN_WORKSPACE, 'Pin the caller workspace before isolated boot');
  const digest = createHash('sha256').update(readFileSync(`/proc/${tauriPID}/exe`)).digest('hex');
  // The app uses disposable PG; the recorder observes the shared ledger.
  // Publish the kernel witness through the existing reporter in a child with
  // that ledger route, leaving this process's app database/identity intact.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { reportRuntimeVintage, listRuntimeVintage, measureRuntimeVintageEnvironment } =
      await import('./packages/operator-core/lib/runtime-vintage.ts');
    const { getOrgPg } = await import('@papercusp/db-org');
    const input = JSON.parse(process.argv[1]);
    try {
      await reportRuntimeVintage(input);
      if (!measureRuntimeVintageEnvironment(await listRuntimeVintage(input.workspaceId), [input.unit]))
        throw new Error('Native executable has no current kernel-verified runtime identity');
    } finally { await getOrgPg().sql.end({ timeout: 5 }); }
  `, JSON.stringify({ workspaceId: process.env.PAPERCUSP_TEST_RUN_WORKSPACE,
    unit: runtimeUnits[0], pid: tauriPID, treeSha: receipt.sourceCommit,
    bundleVersion: 'executable-sha256:' + digest })], {
    cwd: sourceRoot, stdio: 'inherit', timeout: 60_000, env: nativeLedgerEnvironment(),
  });

  for (const script of nativeScripts) {
    const bundle = join(sourceRoot, 'apps/operator/dist-verify', `native-${basename(script, '.mts')}.mjs`);
    execFileSync('bash', [join(sourceRoot, 'apps/operator/bin/bundle-host.sh'), join(sourceRoot, script), bundle],
      { cwd: sourceRoot, stdio: 'inherit', timeout: 300_000, env: testEnv });
    const bytes = readFileSync(bundle);
    assert.ok(bytes.length > 0, 'Native child preparation must produce a non-empty bundle');
    profile.nativeChildren.push({ script, bundle, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // Compilers must not move the source boundary while preparing runtime artifacts.
  verifyVerifierSourceSync(sourceRoot, receipt, { runtimeArtifacts: true });

  const profileDir = mkdtempSync(join(nativeTmpDir, 'reports-native-profile-'));
  const profilePath = join(profileDir, 'profile.json');
  profile.runtimeUnits = runtimeUnits;
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  try {
    // The archive is already verified against its independent commit receipt.
    // Its maintained recorder checks source integrity at both test boundaries;
    // lint:as-committed would wrongly require Git inside this archive.
    execFileSync('npm', ['run', 'test:file', '--', ...testFiles],
    { cwd: sourceRoot, stdio: 'inherit', env: { ...testEnv,
      PAPERCUSP_TEST_RUN_COMMIT: receipt.sourceCommit, PAPERCUSP_APP_OPERATION_LIVE_PROFILE: profilePath } });
  } finally { rmSync(profileDir, { recursive: true, force: true }); }
}

async function verifyReports(evidenceDir: string) {
  assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Fixture publication requires isolated verifier state');
  const pid = process.env.VERIFY_TAURI_PID!;
  const workspace = process.env.PAPERCUSP_WORKSPACE!;
  assert.ok(pid && workspace && process.env.VERIFY_TAURI_POLL, 'Native bridge and polling helper required');
  mkdirSync(evidenceDir, { recursive: true });
  const native = (...args: string[]) => execFileSync(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools',
    [...args, '--pid', pid], { encoding: 'utf8', timeout: 60_000 });
  const save = (name: string, value: unknown) => writeFileSync(join(evidenceDir, name), JSON.stringify(value, null, 2));
  const transportSnapshot = () => JSON.parse(native('eval', `JSON.stringify({
    url: location.href,
    sync: window.__sync_metrics__?.snapshot(),
    ipc: window.__ipcInspector?.summary(),
    resources: performance.getEntriesByType('resource').map(entry => entry.name)
      .filter(name => /zero-harness|agent-mcp/.test(name)).slice(-30)
  })`));
  const sourcePaths = ['apps/operator-vite/src/components/reports/ReportsRoute.tsx',
    'apps/operator-vite/src/components/reports/ReportsRoute.css',
    'apps/operator-vite/src/routes/reports.tsx', 'packages/operator-core/lib/sync-resolver/reports.ts',
    'packages/operator-core/lib/report-library.ts', 'packages/operator-core/lib/report-publication.ts',
    'packages/operator-core/lib/agent-tools/reports/publish.ts', 'packages/operator-core/lib/agent-tools/reports/retire.ts',
    'packages/operator-core/lib/agent-tools/reports/_shared.ts'];
  const fingerprints = () => sourcePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const before = fingerprints();
  let step = 0;
  const poll = (expression: string, require = '.reports-page') => {
    const output = execFileSync(process.env.VERIFY_TAURI_POLL!, ['--require', require, '--eval', expression],
      { encoding: 'utf8', timeout: 90_000, env: { ...process.env, VERIFY_TAURI_DOM_TIMEOUT: '60' } });
    writeFileSync(join(evidenceDir, `assert-${++step}.json`), output);
  };
  const title = 'Reports native verification';
  const body = '# Findings\n\nA complete private report.\n\n```mermaid\ngraph TD; A[Published] --> B[Reader]\n```\n';
  const subject = { kind: 'external', ref: 'reports-native-fixture', label: 'Native acceptance subject' };
  const runTool = (name: string, args: Record<string, unknown>) => {
    native('eval', `window.__reportsPublication = { done: false }; void (async () => {
      try {
        const response = await fetch('/api/agent-mcp/run-tool', { method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify(${JSON.stringify({ name, args, confirmed: true })}) });
        const envelope = await response.json();
        const result = envelope.result;
        const record = result?.data ?? (result?.content?.find(x => x.type === 'text')
          ? JSON.parse(result.content.find(x => x.type === 'text').text) : result);
        window.__reportsPublication = { done:true, status:response.status, envelope, record };
      } catch(error) { window.__reportsPublication = { done:true, error:String(error) }; }
    })()`);
    poll('window.__reportsPublication?.done === true');
    const published = JSON.parse(native('eval', 'JSON.stringify(window.__reportsPublication)'));
    save(`tool-${name.replace(':', '-')}-${step}.json`, published);
    assert.equal(published.status, 200, 'Native tool transport failed');
    assert.notEqual(published.envelope.result?.isError, true, `${name} refused the request`);
    return published.record;
  };
  const publish = (args: Record<string, unknown>) => {
    const published = runTool('reports:publish', args);
    assert.equal(published?.ok, true, 'Publisher refused the fixture');
    assert.ok(published.report_id && published.path, 'Publication must return an exact citation');
    return published;
  };
  try {
    native('navigate', `/reports?ws=${encodeURIComponent(workspace)}`, '--json');
    // A mounted list is not evidence that its first read or invalidation
    // subscription is ready. Measure both before exercising push delivery.
    poll(`(() => { const snapshot = window.__sync_metrics__?.snapshot();
      const query = snapshot?.byQuery?.['reports.list'];
      return !!document.querySelector('.reports-list')
        && !document.querySelector('.reports-list [role="status"]')
        && snapshot?.sse?.connectedSinceMs != null
        && query?.requests > query?.failures; })()`);
    const transportBefore = transportSnapshot();
    save('transport-before.json', transportBefore);
    const original = publish({ title, body_md: body, kind: 'audit', subject,
      request_key: 'reports-native-original', tags: ['native-fixture'] });
    // No refresh/navigation between publish and this assertion: arrival exercises SSE.
    poll(`Array.from(document.querySelectorAll('.reports-list-item')).some(n => n.textContent.includes(${JSON.stringify(title)}))`);
    const transportAfter = transportSnapshot();
    save('transport-after-publish.json', transportAfter);
    const originalReadback = runTool('reports:get', { id: original.report_id });
    assert.equal(originalReadback.results?.[0]?.ok, true, 'The published citation must resolve');
    assert.equal(originalReadback.results?.[0]?.report?.body_md, body, 'Readback preserves complete Markdown');
    assert.equal(originalReadback.results?.[0]?.report?.visibility, 'owner');
    assert.ok((transportAfter.sync?.invalidations?.bySseName?.['reports.list'] ?? 0)
      > (transportBefore.sync?.invalidations?.bySseName?.['reports.list'] ?? 0),
    'Reports arrival must have a measured reports.list SSE invalidation');
    native('navigate', `${original.path}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    poll(`(() => { const rows = Array.from(document.querySelectorAll('.reports-metadata > div'));
      const fields = Object.fromEntries(rows.map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
      return fields['Visibility'] === 'owner' && fields['Subject'] === ${JSON.stringify(subject.label)}
        && fields['Report ID'] === ${JSON.stringify(original.report_id)}
        && ['Written by', 'Pot', 'Published', 'Source'].every(key => !!fields[key]); })()`);
    poll(`Array.from(document.querySelectorAll('.reports-reader svg')).some(svg => svg.textContent.includes('Published') && svg.textContent.includes('Reader'))`);
    native('eval', `window.__reportsCopied = null; Object.defineProperty(navigator, 'clipboard', { configurable:true,
      value:{ writeText:async text => { window.__reportsCopied = text; } } });
      Array.from(document.querySelectorAll('.reports-actions button')).find(b => b.textContent === 'Copy as Markdown').click()`);
    poll(`window.__reportsCopied === ${JSON.stringify(`# ${title}\n\n${body}`)}`);
    const missingReportId = 'rpt_00000000-0000-4000-8000-000000000000';
    native('navigate', `/reports?sel=${missingReportId}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(missingReportId)}
      && document.querySelector('.reports-reader')?.textContent.includes('This report is unavailable.')
      && !document.querySelector('.reports-reader h2')`);
    native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(evidenceDir, 'reports-unknown-citation.png'));
    native('navigate', `${original.path}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(original.report_id)}
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    const correctedTitle = `${title} corrected`;
    const correction = publish({ title: correctedTitle, body_md: body + '\nA correction.\n', supersedes: original.report_id,
      kind: 'audit', subject, request_key: 'reports-native-correction', tags: ['native-fixture'] });
    poll(`Array.from(document.querySelectorAll('.reports-list-item')).filter(n => n.textContent.includes('Reports native verification')).length === 1
      && document.querySelector('.reports-list-item')?.textContent.includes(${JSON.stringify(correctedTitle)})`);
    // Original citation remains pinned even after the superseding publication.
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    native('navigate', `${correction.path}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(correctedTitle)}`);
    native('eval', `Array.from(document.querySelectorAll('.reports-actions button')).find(b => b.textContent === 'Previous version').click()`);
    poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(original.report_id)}
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    native('eval', `Array.from(document.querySelectorAll('.reports-actions button')).find(b => b.textContent === 'Version history').click()`);
    poll(`new URL(location.href).searchParams.get('hist') === 'true'
      && document.querySelectorAll('.reports-history-item').length === 2`);
    native('eval', `Array.from(document.querySelectorAll('.reports-history-item')).find(b => b.textContent.includes(${JSON.stringify(correctedTitle)})).click()`);
    poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(correction.report_id)}
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(correctedTitle)}`);
    const filters = new URLSearchParams({ ws: workspace, kind: 'audit', subject: `${subject.kind}:${subject.ref}`,
      vis: 'owner', q: title, tag: 'native-fixture', since: '2000-01-01', sel: original.report_id, hist: 'true' });
    native('navigate', `/reports?${filters}`, '--json');
    poll(reportsHistoryFilterExpression({ originalTitle: title, correctedTitle,
      subjectValue: `${subject.kind}:${subject.ref}`, subjectLabel: subject.label }));
    // Use the same public tools an agent uses, through the real native tab's
    // presence + intent/SSE transport. Every Reports state field round-trips.
    poll(`!!sessionStorage.getItem('papercusp_ui_client_id')`);
    const clientId = JSON.parse(native('eval', `JSON.stringify(sessionStorage.getItem('papercusp_ui_client_id'))`));
    const drivenParams = Object.fromEntries(filters);
    drivenParams.pot = original.origin.harness_slug ?? 'reports-native-no-such-pot';
    const dispatch = runTool('ui:dispatch', { client_id: clientId, intent: 'set_url',
      args: { path: '/reports', mode: 'replace', params: drivenParams }, timeout_ms: 30_000 });
    assert.equal(dispatch.status, 'done', 'Real Reports tab did not acknowledge ui:dispatch');
    poll(`document.querySelectorAll('.reports-list-item').length === ${original.origin.harness_slug ? 1 : 0}
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}
      && document.querySelectorAll('.reports-history-item').length === 2`);
    let drivenState: ReturnType<typeof runTool> = {};
    for (let attempt = 0; attempt < 20; attempt++) {
      drivenState = runTool('ui:get_state', { client_id: clientId });
      if (Object.entries(drivenParams).every(([key, value]) => drivenState.params?.[key] === value)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(drivenState.pathname, '/reports');
    assert.equal(drivenState.stale, false);
    for (const [key, value] of Object.entries(drivenParams)) assert.equal(drivenState.params[key], value, `UI state lost ${key}`);
    save('agent-control-state.json', { clientId, dispatch, expectedParams: drivenParams, actual: drivenState });
    if (!original.origin.harness_slug) {
      const clearPot = runTool('ui:dispatch', { client_id: clientId, intent: 'set_url',
        args: { params: { pot: null } }, timeout_ms: 30_000 });
      assert.equal(clearPot.status, 'done');
      poll(`document.querySelectorAll('.reports-list-item').length === 1
        && !new URL(location.href).searchParams.has('pot')`);
    }
    const closeReader = runTool('ui:dispatch', { client_id: clientId, intent: 'set_url',
      args: { params: { sel: null, hist: null } }, timeout_ms: 30_000 });
    assert.equal(closeReader.status, 'done');
    poll(`!document.querySelector('.reports-reader h2') && !new URL(location.href).searchParams.has('sel')`);
    const reopenReader = runTool('ui:dispatch', { client_id: clientId, intent: 'set_url',
      args: { params: { sel: original.report_id, hist: 'true', pot: null } }, timeout_ms: 30_000 });
    assert.equal(reopenReader.status, 'done');
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}
      && document.querySelectorAll('.reports-history-item').length === 2`);
    poll(`Object.entries(${JSON.stringify(Object.fromEntries(filters))})
      .every(([key, value]) => new URL(location.href).searchParams.get(key) === value)`);
    filters.set('kind', 'review');
    native('navigate', `/reports?${filters}`, '--json');
    poll(`document.querySelectorAll('.reports-list-item').length === 0
      && document.querySelector('.reports-list')?.textContent.includes('No reports match')
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    native('eval', reportsClearFiltersExpression());
    poll(`['kind','subject','pot','vis','q','tag','since'].every(key => !new URL(location.href).searchParams.has(key))
      && new URL(location.href).searchParams.get('sel') === ${JSON.stringify(original.report_id)}
      && Array.from(document.querySelectorAll('.reports-list-item')).some(b => b.textContent.includes(${JSON.stringify(correctedTitle)}))`);
    // The desktop's other panels can narrow Reports even on a wide viewport.
    poll(`document.querySelector('.reports-reader').getBoundingClientRect().width >= 300`);
    native('eval', `document.querySelector('.reports-reader').scrollIntoView({block:'start'})`);
    native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(evidenceDir, 'reports-reader.png'));
    native('eval', `document.querySelector('.reports-reader svg').scrollIntoView({block:'center'})`);
    native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(evidenceDir, 'reports-diagram.png'));
    const selectRetiring = runTool('ui:dispatch', { client_id: clientId, intent: 'set_url',
      args: { params: { sel: correction.report_id, hist: null } }, timeout_ms: 30_000 });
    assert.equal(selectRetiring.status, 'done');
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(correctedTitle)}`);
    const transportBeforeRetire = transportSnapshot();
    save('transport-before-retire.json', transportBeforeRetire);
    const retired = runTool('reports:retire', { id: correction.report_id });
    assert.equal(retired.ok, true, 'Retirement tool refused the authored fixture');
    assert.equal(retired.results?.[0]?.id, correction.report_id);
    assert.equal(retired.results?.[0]?.ok, true);
    assert.ok(retired.results?.[0]?.report?.retired_at, 'Retirement must keep a soft-state timestamp');
    // No refresh or navigation: removal and the pinned reader must update over SSE.
    poll(`!Array.from(document.querySelectorAll('.reports-list-item')).some(n => n.textContent.includes(${JSON.stringify(correctedTitle)}))
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(correctedTitle)}
      && document.querySelector('.reports-reader')?.textContent.includes('This report was retired.')`);
    const transportAfterRetire = transportSnapshot();
    save('transport-after-retire.json', transportAfterRetire);
    assert.ok((transportAfterRetire.sync?.invalidations?.bySseName?.['reports.list'] ?? 0)
      > (transportBeforeRetire.sync?.invalidations?.bySseName?.['reports.list'] ?? 0),
    'Retirement removal must have a measured reports.list SSE invalidation');
    const retiredReadback = runTool('reports:get', { id: correction.report_id });
    assert.equal(retiredReadback.results?.[0]?.ok, true);
    assert.equal(retiredReadback.results?.[0]?.report?.body_md, body + '\nA correction.\n');
    assert.ok(retiredReadback.results?.[0]?.report?.retired_at, 'The exact retired citation remains readable');
    native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(evidenceDir, 'reports-retired-citation.png'));
    // This is a separate author in the verifier's private database. The UI must
    // exercise the human-owner read path rather than pass by being the author.
    const { getOrgPg } = await import('@papercusp/db-org');
    const { publishReport } = await import('../packages/operator-core/lib/report-library');
    const sql = getOrgPg().sql;
    let privatePeer;
    try {
      privatePeer = await publishReport(sql, { workspaceId: workspace, title: 'Private peer audit',
        bodyMd: body, visibility: 'owner', source: 'native-owner-path-fixture' },
      { authorOwnerId: 'reports-native-foreign-author', authorSessionRef: 'native-owner-path', harnessSlug: 'other-pot' });
    } finally { await sql.end({ timeout: 5 }); }
    native('navigate', `/reports?sel=${encodeURIComponent(privatePeer.reportId)}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`document.querySelector('.reports-reader h2')?.textContent === 'Private peer audit'
      && document.querySelector('.reports-metadata')?.textContent.includes('reports-native-foreign-author')
      && document.querySelector('.reports-metadata')?.textContent.includes('owner')`);
    native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(evidenceDir, 'reports-owner-private.png'));
    const after = fingerprints();
    assert.deepEqual(after, before, 'Relevant source changed during the verification window');
    save('manifest.json', { result: 'pass', original: original.report_id, correction: correction.report_id,
      privatePeer: privatePeer.reportId, retired: correction.report_id, sourceFingerprints: before, assertions: step,
      sse: { before: transportBefore.sync, afterPublish: transportAfter.sync,
        beforeRetire: transportBeforeRetire.sync, afterRetire: transportAfterRetire.sync },
      checked: ['publish-tool', 'publish-exact-readback', 'unknown-citation-isolation',
        'SSE-arrival', 'deep-link', 'metadata', 'Mermaid-render', 'copy-exact-Markdown',
        'lineage-collapse', 'immutable-citation', 'previous-version', 'history-URL', 'history-navigation',
        'filter-restoration', 'agent-tools-filter-state-roundtrip', 'agent-tools-reader-close-reopen',
        'filter-negative-control', 'clear-filters-preserves-citation', 'reader-width', 'human-owner-private-read',
        'retire-tool', 'SSE-retirement', 'retired-citation-readback'] });
  } catch (error) {
    // Keep the original failure even when the diagnostic transport is broken.
    const failure: Record<string, unknown> = { error: String(error), step, sourceFingerprints: before };
    try {
      failure.historyFilterWitness = JSON.parse(native('eval', 'JSON.stringify(window.__reportsHistoryFilterWitness ?? null)'));
      failure.transport = transportSnapshot();
      failure.ui = native('eval', 'JSON.stringify({url:location.href, text:document.body.innerText})');
      native('eval', `window.__reportsReadProbe = { done: false }; void (async () => {
        try {
          const url = '/api/zero-harness/rest-query?name=reports.list&args=' + encodeURIComponent(JSON.stringify({limit:200}));
          const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
          window.__reportsReadProbe = { done:true, status:response.status, body:await response.json() };
        } catch(cause) { window.__reportsReadProbe = { done:true, error:String(cause) }; }
      })()`);
      poll('window.__reportsReadProbe?.done === true');
      failure.directRead = JSON.parse(native('eval', 'JSON.stringify(window.__reportsReadProbe)'));
    } catch (cause) { failure.diagnosticError = String(cause); }
    save('failure.json', failure);
    throw error;
  }
}

async function main() {
  if (process.argv.includes('--check-ledger')) {
    checkNativeLedger(); console.log('REPORTS_NATIVE_LEDGER_PREFLIGHT_OK'); return;
  }
  if (process.argv.includes('--e2e')) { await runNativeE2e(); return; }
  const selection = parseSelectionArgs(process.argv.slice(2));
  const result = await runHarness({ contract: { name: 'reports-library-tauri',
  phases: [{ id: 'native', description: 'Real Reports publication, SSE and native reader' }] },
  evidenceRoot: defaultEvidenceRoot('reports-library-tauri'), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) { ctx.markStep('isolated-native-Reports'); await verifyReports(ctx.evidenceDir); return { ok: true }; },
});
  console.log(`REPORTS_LIBRARY_TAURI_${result.verdict.toUpperCase()} evidence=${result.evidenceDir}`);
  process.exitCode = result.verdict === 'pass' ? 0 : 1;
}
if (isCliEntry(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1; });
