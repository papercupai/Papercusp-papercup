/** Real native CLI fixture: preserve the selected runtime and producer budgets. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAgentMcpBaseUrl } from '../mcp-base-url';
import { processGroupLifetime } from '../fleet/process-group-lifetime';
import { PTOOL_CONNECT_TIMEOUT_MS, PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS,
  PTOOL_LIST_TOOLS_TIMEOUT_MS, timeoutForTool } from '../../../../apps/operator/scripts/ptool.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const processHeadroomMs = PTOOL_LIST_TOOLS_TIMEOUT_MS;

/** Load TS fixture source without installing a global loader over built artifacts. */
export function scopedNativeFixtureArgs(fixtureUrl: string, entry: string, argv: string[]) {
  const script = `
    import { tsImport } from 'tsx/esm/api';
    const fixture = await tsImport(${JSON.stringify(fixtureUrl)}, ${JSON.stringify(fixtureUrl)});
    await fixture[${JSON.stringify(entry)}](process.argv.slice(1), url => import(url));
  `;
  return ['--input-type=module', '-e', script, ...argv];
}

/** Preserve phase evidence while a private fixture runs, including on deadline. */
export async function nativeFixtureProcess(command: string, argv: string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number;
  onOutput?: (text: string, timing: { elapsedMs: number; remainingMs: number }) => void;
}) {
  const startedAt = performance.now();
  const child = spawn(command, argv, { cwd: options.cwd, env: options.env,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let head = '', tail = '', failureOutput = '', failureLines = 0, phaseCount = 0;
  const phases: { elapsedMs: number; line: string }[] = [];
  const pending = new Map<object, string>();
  const clock = () => ({ elapsedMs: Math.round(performance.now() - startedAt),
    remainingMs: Math.max(0, options.timeoutMs - Math.round(performance.now() - startedAt)) });
  const capture = (text: string, stream: object) => {
    if (head.length < 8_000) head = (head + text).slice(0, 8_000);
    tail = (tail + text).slice(-30_000);
    const lines = ((pending.get(stream) ?? '') + text).split('\n');
    pending.set(stream, lines.pop()!.slice(-2_000));
    for (const line of lines) {
      // Cleanup can erase the assertion from both bounded stdout/stderr tails.
      // Retain the first exception and its context independently of that noise.
      if (failureLines === 0 && !failureOutput && /\b(?:[A-Z]\w*Error|Error)(?:\s*\[[^\]]+\])?(?::|\s*$)/.test(line)) {
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
    ...clock(), phaseCount, phases })}\nfailure:\n${failureOutput}\nstartup:\n${head}\ntail:\n${tail}`;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = lifetime.terminate().catch(error => {
      capture(`\nCleanup failed: ${String(error)}\n`, child);
    });
  }, options.timeoutMs);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    if (termination) await termination;
    else await lifetime.waitForExit({ timeoutMs: 10_000 });
    if (timedOut) throw new Error(`Private fixture deadline ${options.timeoutMs}ms exceeded\n${evidence()}`);
    return { ...result, failureOutput, output: evidence() };
  } finally { clearTimeout(timer); }
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
  const cliUrl = staging ? resolveAgentMcpBaseUrl(baseUrl, {
    ...env, PAPERCUSP_MCP_STAGING_PROXY_PORT: inherited.PAPERCUSP_MCP_STAGING_PROXY_PORT ?? '9171',
  }) : baseUrl.replace(/\/$/, '');
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
  const plan = nativeCliPlan(baseUrl, name, args);
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
    pageArgs => nativeCliCall(baseUrl, 'capability:read', pageArgs, invoke), options) as Record<string, any>;
}
