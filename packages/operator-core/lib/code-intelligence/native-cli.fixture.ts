/** Real native CLI fixture: preserve the selected runtime and producer budgets. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { decideWatchdogExpiry } from '../../../../scripts/lib/batch-watchdog.mjs';
import { moduleRepoRoot } from '../module-repo-root';
import { resolveAgentMcpBaseUrl } from '../mcp-base-url';
import { processGroupLifetime } from '../fleet/process-group-lifetime';
import { PTOOL_CONNECT_TIMEOUT_MS, PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS,
  PTOOL_LIST_TOOLS_TIMEOUT_MS, timeoutForTool } from '../../../../apps/operator/scripts/ptool.mjs';

const repoRoot = moduleRepoRoot(import.meta.url);
const processHeadroomMs = PTOOL_LIST_TOOLS_TIMEOUT_MS;

/** Completion's home-repository reader uses the papercusp serving key even
 * inside a private operator. Publish there and observe the cooperative load;
 * writing a harness-specific clone snapshot alone does not ready that reader. */
export async function preparePrivateNativeCallerSnapshot(workspace: string, contents: string): Promise<void> {
  if (!workspace.startsWith('test-runtime-')) throw new Error('Caller snapshot preparation requires a private native workspace');
  const { dependencySnapshotPath } = await import('./dependency-snapshot-path.ts');
  const { parsePushSnapshot, peekPushSnapshot, pushSnapshotMissReason } = await import('./push-snapshot.ts');
  const expected = parsePushSnapshot(contents);
  if (!expected?.symbols?.size) throw new Error('Private caller snapshot must contain validated symbols');
  const path = dependencySnapshotPath('papercusp');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  const deadline = Date.now() + 5_000;
  do {
    const loaded = peekPushSnapshot('papercusp');
    if (loaded?.generatedAt === expected.generatedAt
      && [...expected.symbols.keys()].every(name => loaded.symbols?.has(name))) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Private caller snapshot did not load: ${pushSnapshotMissReason('papercusp') ?? 'different generation'}`);
}

/**
 * First line of a child failure: a JS `…Error:`, or a LINE-LEADING shell `ERROR:` / esbuild
 * `✘ [ERROR]` / bundle refusal marker. The shell forms are anchored because bundle-host.sh's
 * output echoes guard source such as `echo "ERROR: host bundle requires esbuild …"` long before
 * any real failure, and only the first match is retained.
 */
export const FIXTURE_FAILURE_LINE =
  /\b(?:[A-Z]\w*Error|Error)(?:\s*\[[^\]]+\])?(?::|\s*$)|^\s*(?:🚨\s*)?ERROR:|^\s*✘\s*\[ERROR\]|^BUNDLE_RESTRICTED_HOLD_REFUSED\b/;

/** Load TS fixture source without installing a global loader over built artifacts. */
export function scopedNativeFixtureArgs(fixtureUrl: string, entry: string, argv: string[]) {
  const script = `
    import { tsImport } from 'tsx/esm/api';
    const fixture = await tsImport(${JSON.stringify(fixtureUrl)}, ${JSON.stringify(fixtureUrl)});
    await fixture[${JSON.stringify(entry)}](process.argv.slice(1), url => import(url));
  `;
  return ['--input-type=module', '-e', script, ...argv];
}

/** One step from a bundle-host.sh journal, in ms relative to the fixture start. */
export type FixtureJournalStep = { step: string; startMs: number; durMs: number; rc: number };

/**
 * Incremental reader for a bundle-host.sh step journal (`$OUTFILE.build-steps.jsonl`).
 * Progress is only a fully appended `end` row with status 0 that closes a `start` row from the
 * same pid written after the fixture started. buildPrivateOperatorApiBundle applies the same
 * rule, so stale, torn, interleaved or failed rows never extend a deadline.
 */
export function bundleStepJournal(path: string, startedAtEpochMs: number) {
  const completed = new Set<string>();
  const open = new Map<string, number>();
  const steps: FixtureJournalStep[] = [];
  let rowsSeen = 0;
  return {
    /** Fold newly appended rows; returns how many steps newly completed with status 0. */
    sample(): number {
      if (!existsSync(path)) return 0;
      const lines = readFileSync(path, 'utf8').split('\n').slice(0, -1);
      let advanced = 0;
      for (const line of lines.slice(rowsSeen)) {
        let row: { at?: unknown; pid?: unknown; step?: unknown; event?: unknown; status?: unknown };
        try { row = JSON.parse(line); } catch { continue; }
        if (typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < startedAtEpochMs / 1000
          || !Number.isSafeInteger(row.pid) || (row.pid as number) <= 0
          || typeof row.step !== 'string' || !row.step) continue;
        const key = `${row.pid}:${row.step}`;
        if (row.event === 'start') { if (!completed.has(row.step)) open.set(key, row.at); continue; }
        const startAt = row.event === 'end' ? open.get(key) : undefined;
        if (startAt === undefined) continue;
        open.delete(key);
        const rc = typeof row.status === 'number' ? row.status : -1;
        if (steps.length === 64) steps.splice(16, 1);
        steps.push({ step: row.step, startMs: Math.round(startAt * 1000 - startedAtEpochMs),
          durMs: Math.round((row.at - startAt) * 1000), rc });
        if (rc === 0 && !completed.has(row.step)) { completed.add(row.step); advanced++; }
      }
      rowsSeen = lines.length;
      return advanced;
    },
    get steps() { return [...steps]; },
    get openSteps() { return [...open.keys()].map(key => key.slice(key.indexOf(':') + 1)); },
    get completedSteps() { return completed.size; },
  };
}

/**
 * Preserve phase evidence while a private fixture runs, including on deadline.
 *
 * Without `stepJournal` the deadline is fixed at `timeoutMs`. With it, each validated step
 * completion in the child's bundle-host.sh journal renews the deadline (`timeoutMs` is then the
 * stall window) up to the absolute `maxMs` ceiling (EI-27225287785052203: a fresh host bundle
 * spent its whole fixed 120s in startup under load and timed out with no phase evidence).
 */
export async function nativeFixtureProcess(command: string, argv: string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number;
  stepJournal?: string; maxMs?: number; pollMs?: number;
  onOutput?: (text: string, timing: { elapsedMs: number; remainingMs: number }) => void;
}) {
  const maxMs = options.maxMs ?? options.timeoutMs;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isSafeInteger(maxMs)
    || maxMs < options.timeoutMs) {
    throw new Error(`Private fixture deadline must be positive and covered by its ceiling (timeoutMs=${
      options.timeoutMs}, maxMs=${maxMs})`);
  }
  if (options.maxMs !== undefined && !options.stepJournal) {
    throw new Error('A private fixture ceiling needs a step journal to measure progress against');
  }
  if (options.stepJournal && existsSync(options.stepJournal)) {
    throw new Error(`Progress-aware private fixture requires a fresh step journal: ${options.stepJournal}`);
  }
  const journal = options.stepJournal ? bundleStepJournal(options.stepJournal, Date.now()) : undefined;
  let deadlineMs = options.timeoutMs, extensions = 0, killReason: string | null = null;
  const startedAt = performance.now();
  const child = spawn(command, argv, { cwd: options.cwd, env: options.env,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let head = '', tail = '', failureOutput = '', failureLines = 0, phaseCount = 0;
  const phases: { elapsedMs: number; line: string }[] = [];
  const pending = new Map<object, string>();
  const clock = () => ({ elapsedMs: Math.round(performance.now() - startedAt),
    remainingMs: Math.max(0, deadlineMs - Math.round(performance.now() - startedAt)) });
  const capture = (text: string, stream: object) => {
    if (head.length < 8_000) head = (head + text).slice(0, 8_000);
    tail = (tail + text).slice(-30_000);
    const lines = ((pending.get(stream) ?? '') + text).split('\n');
    pending.set(stream, lines.pop()!.slice(-2_000));
    for (const line of lines) {
      // Cleanup can erase the assertion from both bounded stdout/stderr tails.
      // Retain the first exception and its context independently of that noise.
      // Shell producers (bundle-host.sh) fail with `ERROR:` / esbuild `[ERROR]` / the
      // restricted-hold refusal marker; without them the gate ledger kept only argv
      // and an empty primary failure (WI-6554700010030421).
      if (failureLines === 0 && !failureOutput && FIXTURE_FAILURE_LINE.test(line)) {
        failureLines = 24;
      }
      if (failureLines > 0 && failureOutput.length < 8_000) {
        failureOutput = (failureOutput + line.slice(0, 2_000) + '\n').slice(0, 8_000);
        failureLines--;
      }
      if (!/^(?:NATIVE_[A-Z_]+(?:STAGE|PROGRESS)=|\[with-test-pg\] (?:pg |operator-api stage|starting))/.test(line)) continue;
      phaseCount++;
      // Keep both startup and the last transitions when a noisy child exceeds
      // the trace budget. The tail alone used to erase PG/bootstrap attribution.
      if (phases.length === 128) phases.splice(64, 1);
      phases.push({ elapsedMs: clock().elapsedMs, line: line.slice(0, 700) });
    }
    options.onOutput?.(text, clock());
  };
  const lifetime = processGroupLifetime(child, message => capture(message + '\n', child));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    capture(String(data), stream);
  });
  const evidence = () => `NATIVE_FIXTURE_TIMING=${JSON.stringify({ timeoutMs: options.timeoutMs,
    ...clock(), phaseCount, phases,
    // Name the producer step a deadline interrupted, not just that it expired.
    ...(journal && { maxMs, deadlineMs, extensions, killReason, completedSteps: journal.completedSteps,
      openSteps: journal.openSteps, steps: journal.steps }) })}\nfailure:\n${failureOutput}\nstartup:\n${
    head}\ntail:\n${tail}`;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let lastProgressAt: number | null = null;
  const observeJournal = () => {
    try { if (journal && journal.sample() > 0) lastProgressAt = performance.now(); }
    catch (error) { capture(`\nStep journal unreadable: ${String(error)}\n`, child); }
  };
  const poll = journal && managedSetInterval('native-fixture-step-journal', options.pollMs ?? 250, observeJournal,
    { category: 'watchdog', classification: 'must-sample', instanced: true, allowInTest: true });
  let timer: ReturnType<typeof setTimeout>;
  const expire = () => {
    observeJournal();
    const elapsedMs = performance.now() - startedAt;
    // Same policy as the private operator builder: no validated completion kills on time,
    // a stall longer than one window kills, and nothing outlives the absolute ceiling.
    const decision = decideWatchdogExpiry({ elapsedMs, maxMs,
      lastProgressAgeMs: lastProgressAt === null ? null : performance.now() - lastProgressAt,
      stallWindowMs: options.timeoutMs, extensionMs: options.timeoutMs });
    if (decision.action === 'extend') {
      extensions++;
      deadlineMs = Math.round(elapsedMs + decision.extendByMs);
      timer = setTimeout(expire, decision.extendByMs);
      return;
    }
    killReason = decision.reason;
    timedOut = true;
    termination = lifetime.terminate().catch(error => {
      capture(`\nCleanup failed: ${String(error)}\n`, child);
    });
  };
  timer = setTimeout(expire, options.timeoutMs);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    if (termination) await termination;
    else await lifetime.waitForExit({ timeoutMs: 10_000 });
    observeJournal();
    if (timedOut) {
      throw new Error(`Private fixture deadline ${options.timeoutMs}ms exceeded${journal ? ` (${killReason}; ${
        extensions} extension(s), ceiling ${maxMs}ms, open step ${journal.openSteps.at(-1) ?? 'none'})` : ''}\n${
        evidence()}`);
    }
    return { ...result, failureOutput, output: evidence() };
  } finally { clearTimeout(timer); poll?.stop(); }
}

export function nativeCliPlan(baseUrl: string, name: string, args: Record<string, unknown>,
  inherited: NodeJS.ProcessEnv = process.env) {
  const selected = new URL(baseUrl);
  const staging = selected.protocol === 'http:' && selected.port === '3170' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(selected.hostname);
  const env: NodeJS.ProcessEnv = { ...inherited, PAPERCUSP_CONTEXT_TIER: 'full' };
  // An inherited green proxy must never reclassify an alternate/remote pin.
  delete env.PAPERCUSP_MCP_PROXY_BASE;
  delete env.PAPERCUSP_MCP_PROXY_PORT;
  let cliUrl = staging ? resolveAgentMcpBaseUrl(baseUrl, {
    ...env, PAPERCUSP_MCP_STAGING_PROXY_PORT: inherited.PAPERCUSP_MCP_STAGING_PROXY_PORT ?? '9171',
  }) : baseUrl.replace(/\/$/, '');
  // Foreground bash returns prose unless structured output is negotiated.
  // Keep JSON decoding strict and request the tool's maintained exit receipt.
  if (name === 'capability:bash') {
    const structured = new URL(cliUrl);
    structured.searchParams.set('structured', '1');
    cliUrl = structured.toString();
  }
  if (staging) {
    const proxy = new URL(cliUrl);
    if (proxy.origin === selected.origin || ['3070', '9071'].includes(proxy.port)) {
      throw new Error('Native CLI staging fixture requires its maintained MCP proxy');
    }
    env.PAPERCUSP_MCP_PROXY_BASE = cliUrl;
    env.PAPERCUSP_MCP_PROXY_PORT = proxy.port;
  }
  const requestMs = timeoutForTool('tools:invoke', { name, args });
  return { cliUrl, env, timeoutMs: PTOOL_CONNECT_TIMEOUT_MS + PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS + requestMs + processHeadroomMs };
}

export function nativeCliTestTimeout(names: string[]) {
  return names.reduce<number>((total, name) => total + nativeCliPlan('http://127.0.0.1:3170', name, {}).timeoutMs,
    processHeadroomMs);
}

export function nativeCliResult(result: { status: number | null; stdout: string; stderr: string; error?: Error; signal?: string | null }) {
  const evidence = `status=${result.status} signal=${result.signal ?? 'none'} error=${result.error?.message ?? 'none'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  if (result.status !== 0 || result.error) throw new Error(`Native CLI process failed\n${evidence}`);
  let parsed: { ok?: boolean; data?: unknown };
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`Native CLI returned invalid JSON\n${evidence}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Native CLI returned an invalid response shape\n${evidence}`);
  }
  if (parsed.ok === false) throw new Error(`Native CLI tool refused\n${evidence}`);
  if ('schemaVersion' in parsed && parsed.schemaVersion === 'papercusp.output-envelope/v1'
    && 'state' in parsed && parsed.state === 'incomplete') {
    throw new Error(`Native CLI returned incomplete evidence; request the exact required fields\n${evidence}`);
  }
  // Only the legacy object wrapper is a transport envelope. Byte readers own
  // their base64 `data` field, so preserve the complete page and its cursor.
  return parsed.data !== null && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    && Object.keys(parsed).every(key => key === 'ok' || key === 'data') ? parsed.data : parsed;
}

export type NativeCliRecoveryOptions = {
  /** Explicit fixture scope; ptool environment flags override URL query scope. */
  env?: NodeJS.ProcessEnv;
  /**
   * Accept a field-truncated result door only when the caller requested a
   * projection and the door contains a complete JSON projection item. The
   * default remains fail-closed for all incomplete envelopes.
   */
  allowProjectedPartial?: boolean;
};

/** Expand only explicitly recoverable result-door references; never accept a partial source. */
export function recoverNativeCliResult(result: Parameters<typeof nativeCliResult>[0],
  read: (args: Record<string, unknown>) => Record<string, any>,
  options: NativeCliRecoveryOptions = {}) {
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { return nativeCliResult(result); }
  const projectedPartial = options.allowProjectedPartial === true
    && envelope?.incomplete?.reason === 'under-budget-partial-result'
    && envelope.incomplete.recoverable === false;
  if (result.status !== 0 || result.error || envelope?.schemaVersion !== 'papercusp.output-envelope/v1'
    || envelope.state !== 'incomplete'
    || (envelope.incomplete?.recoverable !== true && !projectedPartial)) return nativeCliResult(result);
  const reference = envelope.content?.length === 1 ? envelope.content[0] : null;
  if (reference?.kind !== 'reference' || typeof reference.uri !== 'string') return nativeCliResult(result);
  const pages: Buffer[] = [];
  let args: Record<string, unknown> | null = { file_path: reference.uri, byte_offset: 0, byte_limit: 2_048 };
  let manifest: { byteCount: number; sha256: string } | undefined;
  for (let count = 0; args && count < 64; count++) {
    const page = read(args);
    const bytes = Buffer.from(page.data ?? '', 'base64');
    if (page.ok !== true || page.encoding !== 'base64' || bytes.toString('base64') !== page.data
      || bytes.length !== page.byte_length || page.byte_offset !== Buffer.concat(pages).length
      || page.reference?.schemaVersion !== 'papercusp.scratch-reference/v1'
      || Boolean(page.next_cursor) === Boolean(page.eof)) throw new Error('Invalid native CLI recovery byte page');
    manifest ??= page.reference;
    if (manifest?.byteCount !== page.total_bytes || manifest?.sha256 !== page.reference.sha256)
      throw new Error('Native CLI recovery reference changed between pages');
    pages.push(bytes);
    if (page.next_cursor && page.next_cursor.tool !== 'capability:read') throw new Error('Invalid native CLI recovery cursor');
    args = page.next_cursor?.args ?? null;
  }
  const payload = Buffer.concat(pages);
  if (args || payload.length !== manifest?.byteCount
    || createHash('sha256').update(payload).digest('hex') !== manifest?.sha256)
    throw new Error('Native CLI recovery reference integrity failed');
  const recovered = JSON.parse(payload.toString('utf8'));
  if (recovered.isError === true || !Array.isArray(recovered.content))
    throw new Error('Invalid native CLI recovery payload');
  if (recovered.content.length === 1 && recovered.content[0].type === 'text')
    return nativeCliResult({ ...result, stdout: recovered.content[0].text });
  if (!projectedPartial) throw new Error('Invalid native CLI recovery payload');
  const projected = recovered.content
    .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry: any) => {
      try { return JSON.parse(entry.text); } catch { return null; }
    })
    .find((entry: any) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && !(entry.schemaVersion === 'papercusp.output-envelope/v1' && entry.state === 'incomplete'));
  if (!projected) throw new Error('Invalid native CLI projected recovery payload');
  return nativeCliResult({ ...result, stdout: JSON.stringify(projected) });
}

export function nativeCliCall(baseUrl: string, name: string, args: Record<string, unknown>,
  invoke: typeof spawnSync = spawnSync, options: NativeCliRecoveryOptions = {}): Record<string, any> {
  const plan = nativeCliPlan(baseUrl, name, args, options.env ?? process.env);
  const startedAt = performance.now();
  // Write to the worker's actual descriptor: Vitest buffers console output until
  // the file settles, hiding completed requests from the router's existing
  // progress-aware watchdog. These are real transitions, never timer heartbeats.
  const progress = (state: string, result?: { status: number | null; signal: string | null }) => {
    writeSync(2, `NATIVE_CLI_PROGRESS=${JSON.stringify({ state, name,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...(result ? { status: result.status, signal: result.signal } : {}) })}\n`);
  };
  progress('started');
  let result;
  try {
    result = invoke(process.execPath, [join(repoRoot, 'apps/operator/scripts/ptool.mjs'),
      name, `--url=${plan.cliUrl}`, '--json', '-'], {
      cwd: repoRoot, encoding: 'utf8', timeout: plan.timeoutMs, input: JSON.stringify(args), env: plan.env,
    });
  } catch (error) {
    progress('launch-error');
    throw error;
  }
  progress('settled', result);
  return recoverNativeCliResult(result,
    pageArgs => nativeCliCall(baseUrl, 'capability:read', pageArgs, invoke, options), options) as Record<string, any>;
}
