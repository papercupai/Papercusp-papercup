/** Real pipe framing, with opt-in installed-native protocol startup. The test
 * runner owns the subprocess cgroup; only DB-backed enrollment is substituted.
 * Scripted loopback Responses fixtures perform no provider inference. The
 * separately opted-in platform case inherits only this caller's MCP credential;
 * no SU launch, provider credential, or native user interface is needed. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RpcFrame, SuStdioPeer, SuStdioReceipt } from './su-session-stdio-peer';

const NEVER_EMIT_MARKER = 'never-emit-me';

const processState = vi.hoisted(() => ({ children: new Map<string, ChildProcess>(), stderr: '', killFailure: '', killError: '' }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (binary: string, args: string[], _spec: unknown, options: { spawnOptions: object }) => {
  const child = spawn(binary, args, options.spawnOptions);
  const taskId = randomUUID(); processState.children.set(taskId, child);
  child.stderr?.on('data', (chunk) => { processState.stderr = (processState.stderr + chunk).slice(-1000); });
  return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (taskId: string) => {
  processState.children.get(taskId)?.kill('SIGKILL');
  return processState.killFailure
    ? { ok: false, error: processState.killError || 'command_failed', detail: processState.killFailure }
    : { ok: true };
} }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', () => ({ startSupervisorBeat: vi.fn() }));
import { startSuStdioPeer } from './su-session-stdio-peer';
import { processMonotonicClock } from './process-monotonic-clock';
import { inspectCarryNativeTurn, inspectCarrySourceRead, createCarryTrialRecipe, inspectCarryTaskResponse, inspectCarryPreparationResponse,
  inspectCarryRequestPopulation, inspectCarryNativePopulation, measureCarryArmTiming, type CarryCanonicalUsageRow } from './launch-cost/launch-cost-metrics';
import { captureCarryCanonicalUsagePopulation, captureCarryRequestEvidence } from './launch-cost/scan-launch-transcripts';
import { GatewayRequestTelemetry } from './inference-gateway/request-stage-telemetry';
import * as dbOrg from '@papercusp/db-org';
import * as workspaceRegistry from './workspace-registry';
import { createOrgTestDb } from '../test/_org-test-db';
import { ingestInteractiveUsage } from './interactive-usage/ingest-claude-transcripts';
import { parseCodexChunk, codexSessionIdForFile } from './interactive-usage/ingest-adapters';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import sourceReadTool from './agent-tools/capability/read';
import { captureCompletedCarrySource, captureCarrySourcePreflight, recheckCarrySourceSnapshot, captureCarryNativeConfiguration,
  captureCarryArtifactManifest, recheckCarryArtifactManifest, captureCarryRuntimeSnapshot, recheckCarryRuntimeSnapshot,
  type CarrySourceSnapshot, type CarryArtifactInput, type CarryDependencyScope } from './launch-cost/scan-launch-transcripts';

const peers: SuStdioPeer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  processState.children.clear(); processState.stderr = ''; processState.killFailure = ''; processState.killError = '';
});

async function peer(binary: string, args: string[], env: NodeJS.ProcessEnv = {}, onMessage = (_frame: RpcFrame) => {}, config?: string,
  onReceipt?: (receipt: SuStdioReceipt) => void, existingHome?: string) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'pui-native-protocol-'));
  if (!existingHome) homes.push(home);
  if (config) writeFileSync(join(home, 'config.toml'), config, { mode: 0o600 });
  const result = await startSuStdioPeer({ binary, args, cwd: home,
    env: { PATH: process.env.PATH, CODEX_HOME: home, PI_CODING_AGENT_DIR: home, ...env },
    workspaceId: 'protocol-test', ownerId: 'su-protocol-test',
    spec: { class: 'test', title: 'PUI native protocol test', launchedBy: 'vitest', argv: [binary, ...args] }, onMessage, onReceipt });
  peers.push(result); return result;
}

/** Owned-fixture Node loader observations. The hook delegates to the actual
 * loader and records its returned branch/conditions; it never guesses exports
 * from package.json. This does not observe Rust loads, arbitrary data reads,
 * earlier hooks, or unexecuted branches, and is not production admission. */
function nodeLoaderProbe(home: string, name: string) {
  const hookPath = join(home, `${name}-loader.mjs`), tracePath = join(home, `${name}-loader.jsonl`);
  writeFileSync(hookPath, `
    import { registerHooks } from 'node:module';
    import { appendFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { fileURLToPath } from 'node:url';
    const tracePath = process.env.PAPERCUSP_CARRY_LOADER_TRACE;
    if (!tracePath) throw new Error('missing owned loader trace path');
    let sequence = 0, bytes = 0, failed = false;
    const hash = value => createHash('sha256').update(value).digest('hex');
    const urlFields = url => ({ urlSha256: hash(url),
      ...(url.startsWith('file:') ? { filePath: fileURLToPath(url) } : {}) });
    const record = value => {
      if (failed) throw new Error('owned loader trace bound exceeded');
      const line = JSON.stringify({ sequence: sequence + 1, pid: process.pid, ...value }) + '\\n';
      if (sequence >= 4096 || bytes + Buffer.byteLength(line) > 1024 * 1024) {
        failed = true;
        // Poison the frozen observation once, even if the program catches the
        // loader error. Never present a silently truncated prefix as complete.
        appendFileSync(tracePath, JSON.stringify({ sequence: ++sequence, pid: process.pid, phase: 'overflow' }) + '\\n');
        throw new Error('owned loader trace bound exceeded');
      }
      appendFileSync(tracePath, line, { mode: 0o600 });
      sequence++; bytes += Buffer.byteLength(line);
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const input = { phase: 'resolve', specifierSha256: hash(specifier),
          ...(context.parentURL ? { parentUrlSha256: hash(context.parentURL) } : {}),
          conditions: [...context.conditions] };
        try {
          const result = nextResolve(specifier, context);
          record({ ...input, outcome: 'resolved', ...urlFields(result.url), format: result.format ?? null });
          return result;
        } catch (error) {
          record({ ...input, outcome: 'error', code: typeof error.code === 'string' ? error.code : 'unknown' });
          throw error;
        }
      },
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        const source = typeof result.source === 'string' ? result.source
          : result.source instanceof ArrayBuffer ? Buffer.from(result.source)
          : ArrayBuffer.isView(result.source) ? Buffer.from(result.source.buffer, result.source.byteOffset, result.source.byteLength) : null;
        record({ phase: 'load', ...urlFields(url), format: result.format ?? null,
          sourceSha256: source === null ? null : hash(source) });
        return result;
      },
    });
    record({ phase: 'start', nodeVersion: process.version });
  `, { mode: 0o600 });
  return { hookPath, tracePath, env: { NODE_OPTIONS: `--import=${JSON.stringify(hookPath)}`, PAPERCUSP_CARRY_LOADER_TRACE: tracePath },
    read(pid: number) {
      expect(lstatSync(tracePath).size).toBeLessThan(1024 * 1024);
      const text = readFileSync(tracePath, 'utf8');
      expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
      expect(text.endsWith('\n')).toBe(true);
      const rows = text.trimEnd().split('\n').map(line => JSON.parse(line) as {
        sequence: number; pid: number; phase: string; conditions?: string[];
        filePath?: string; format?: string | null; outcome?: string; code?: string; sourceSha256?: string | null;
      });
      expect(rows[0]).toMatchObject({ phase: 'start', pid, sequence: 1 });
      expect(rows.every(row => row.pid === pid)).toBe(true);
      expect(rows.map(row => row.sequence)).toEqual(rows.map((_, index) => index + 1));
      expect(rows.every(row => ['start', 'resolve', 'load'].includes(row.phase)), 'loader trace must not overflow').toBe(true);
      return rows;
    } };
}

/** Linux owned-fixture observation only. -s 0 suppresses syscall buffer contents;
 * -yy still resolves descriptor labels at the syscall. The file-size limit also
 * applies to the tracee, so this instrumentation must never measure production
 * latency or stand in for an uninstrumented paired arm. */
function syscallFileProbe(home: string, name: string) {
  const tracePath = join(home, `${name}-syscalls.log`), maxBytes = 8 * 1024 * 1024;
  writeFileSync(tracePath, '', { mode: 0o600 });
  const parse = (text: string) => {
    if (!text.endsWith('\n') || Buffer.byteLength(text) >= maxBytes) throw new Error('incomplete owned syscall trace');
    const pending = new Map<number, string>(), exited = new Set<number>(), seen = new Set<number>();
    const accesses: Array<{ tid: number; syscall: string; filePath: string; result: string }> = [];
    let unavailableLabels = 0, failedCalls = 0;
    for (const line of text.trimEnd().split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) throw new Error('unrecognized owned syscall trace row');
      const pid = Number(match[1]); let call = match[2]; seen.add(pid);
      if (exited.has(pid)) throw new Error('owned syscall row after exit');
      if (call === '+++ exited with 0 +++') { exited.add(pid); continue; }
      if (call.startsWith('--- ')) continue; // signals carry no read-completeness claim
      if (call.endsWith('<unfinished ...>')) {
        if (pending.has(pid)) throw new Error('overlapping owned syscall trace row');
        pending.set(pid, call.slice(0, -'<unfinished ...>'.length)); continue;
      }
      const resumed = call.match(/^<\.\.\. (\w+) resumed>(.*)$/);
      if (resumed) {
        const prefix = pending.get(pid);
        if (!prefix?.startsWith(`${resumed[1]}(`)) throw new Error('unmatched owned syscall continuation');
        call = prefix + resumed[2]; pending.delete(pid);
      }
      const result = call.match(/^(\w+)\((.*)\)\s+=\s+(-?\d+|0x[\da-f]+)(?:<.*>)?(?:\s.*)?$/);
      if (!result) throw new Error(`incomplete owned syscall result (${call.match(/^(\w+)\(/)?.[1] ?? 'lifecycle'})`);
      const [, syscall, args, value] = result;
      if (Number(value) < 0) { failedCalls++; continue; }
      if (!['read', 'pread64', 'readv', 'preadv', 'preadv2', 'mmap'].includes(syscall)) continue;
      if (syscall !== 'mmap' && Number(value) === 0) continue;
      const descriptor = syscall === 'mmap' ? args.match(/, \d+<([^>]+)>, (?:0|0x[\da-f]+)$/)
        : args.match(/^\d+<([^>]+)>,/);
      // Do not guess escaped/truncated/deleted descriptor paths or non-files.
      // These remain explicit residue; file paths are labels, not inode/byte proof.
      const path = descriptor?.[1];
      if (!path?.startsWith('/') || /[\\<>]| \(deleted\)$/.test(path)) { unavailableLabels++; continue; }
      accesses.push({ tid: pid, syscall, filePath: path, result: value });
    }
    if (pending.size || !seen.size || [...seen].some(pid => !exited.has(pid))) throw new Error('incomplete owned syscall lifecycle');
    return { schemaVersion: 'owned-syscall-files-v1', evidenceKind: 'observation-only',
      traceSha256: createHash('sha256').update(text).digest('hex'), traceBytes: Buffer.byteLength(text),
      tracedTaskIds: [...seen].sort((a, b) => a - b), accesses, unavailableLabels, failedCalls,
      unresolved: ['descriptor labels do not authenticate bytes or inode identity',
        'failed opens, non-file descriptors and escaped/deleted paths are not resolved',
        'unselected syscalls, unexercised branches, external writers and production equivalence remain unproven'] };
  };
  return { tracePath, parse,
    launch: (binary: string, args: string[]) => ({ binary: '/usr/bin/prlimit', args: [`--fsize=${maxBytes}`, '--',
      '/usr/bin/strace', '-f', '-q', '-s', '0', '-yy', '-o', tracePath,
      '-e', 'trace=openat,openat2,read,pread64,readv,preadv,preadv2,mmap,close', '--', binary, ...args] }),
    read: () => {
      if (lstatSync(tracePath).size >= maxBytes) throw new Error('owned syscall trace bound exceeded');
      return parse(readFileSync(tracePath, 'utf8'));
    } };
}

async function waitForMcpStartup(events: RpcFrame[], threadId: string, name: string) {
  const terminal = () => events.find(frame => frame.method === 'mcpServer/startupStatus/updated' &&
    (frame.params as RpcFrame).threadId === threadId && (frame.params as RpcFrame).name === name &&
    ['ready', 'failed', 'cancelled'].includes(String((frame.params as RpcFrame).status)));
  await vi.waitFor(() => expect(terminal() !== undefined).toBe(true), { timeout: 15_000 });
  // Native errors may echo a credential or URL. Report only recognized cause
  // labels; the original frame remains private and never enters assertion output.
  const detail = JSON.stringify((terminal()!.params as RpcFrame).error ?? null);
  const causes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'connection refused', 'connection closed',
    'timed out', 'Unauthorized', 'Forbidden', '404', '401', '403', '502', '503', 'parse', 'initialize']
    .filter(label => detail.toLowerCase().includes(label.toLowerCase()));
  expect((terminal()!.params as RpcFrame).status, `MCP startup causes: ${causes.join(', ') || 'unclassified'}`).toBe('ready');
}

type ControllerModule = {
  id: string; file?: string; evaluated?: boolean; imports: Set<string>;
  meta?: { file?: string | null; code?: string; externalize?: string; mockedModule?: unknown };
};
function controllerModules(): Map<string, ControllerModule> {
  const state = (globalThis as typeof globalThis & {
    __vitest_worker__?: { evaluatedModules?: { idToModuleMap?: Map<string, ControllerModule> } };
  }).__vitest_worker__;
  const modules = state?.evaluatedModules?.idToModuleMap;
  if (!(modules instanceof Map)) throw new Error('owned controller module observation unavailable');
  return modules;
}

/** Read the existing Vite/Vitest cache, not a second resolver. `evaluated` is
 * set in Vite's finally block, including failures: it means settled, NOT success.
 * External/manual mocks and cache entries without code remain explicit residue.
 * This snapshot cannot see evicted entries, native external imports, earlier
 * transforms, production loaders, or arbitrary mutations between rechecks. */
function controllerLoaderProbe(home: string, name: string, selected: CarryArtifactInput[], modules = controllerModules()) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const inspect = () => {
    if (modules.size > 8192) throw new Error('owned controller module population exceeds bound');
    return [...modules].map(([id, node]) => {
      const kind = id.startsWith('mock:') || node.meta?.mockedModule ? 'mocked'
        : node.meta?.externalize !== undefined ? 'external'
        : typeof node.meta?.code === 'string' ? 'transformed' : 'unavailable';
      const path = node.meta?.file ?? node.file;
      const filePath = path && isAbsolute(path) && existsSync(path) ? realpathSync(path) : null;
      return { idSha256: hash(id), filePath, kind, evaluationSettled: node.evaluated === true,
        imports: [...node.imports].map(hash).sort(),
        transformedSha256: kind === 'transformed' ? hash(node.meta!.code!) : null };
    }).sort((a, b) => a.idSha256.localeCompare(b.idSha256));
  };
  const rows = inspect();
  const selectedPaths = new Set(selected.map(a => realpathSync(a.filePath)));
  const selectedRows = rows.filter(row => row.filePath && selectedPaths.has(row.filePath));
  const artifacts: CarryArtifactInput[] = [];
  // Freeze selected returned transform bytes separately from current disk source:
  // a source hash alone is not the JavaScript supplied to the module evaluator.
  for (const row of selectedRows.filter(row => row.kind === 'transformed')) {
    const node = [...modules].find(([id]) => hash(id) === row.idSha256)![1];
    const code = node.meta!.code!;
    if (Buffer.byteLength(code) > 8 * 1024 * 1024) throw new Error('owned controller transform exceeds bound');
    const filePath = join(home, `${name}-${row.idSha256}.js`);
    writeFileSync(filePath, code, { mode: 0o600 });
    artifacts.push({ id: `controller-transform-${row.idSha256}`, filePath, maxBytes: 8 * 1024 * 1024 });
  }
  // Nearest package metadata is an observed disk input, not a claim that every
  // package condition/ancestor consulted by the loader has been discovered.
  const packages = new Set<string>();
  for (const path of selectedPaths) {
    let dir = dirname(path);
    while (true) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) { packages.add(realpathSync(candidate)); break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const path of [...packages].sort()) artifacts.push({
    id: `controller-package-${hash(path)}`, filePath: path, maxBytes: 1024 * 1024,
  });
  const observation = { schemaVersion: 'owned-controller-cache-v1', pid: process.pid, nodeVersion: process.version,
    rows, selectedRows, unmatchedPaths: [...selectedPaths].filter(path => !selectedRows.some(row => row.filePath === path)),
    runtimeClosureEstablished: false };
  const text = JSON.stringify(observation);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('owned controller observation exceeds bound');
  const filePath = join(home, `${name}.json`);
  writeFileSync(filePath, text, { mode: 0o600 });
  artifacts.push({ id: 'controller-observation', filePath, maxBytes: 8 * 1024 * 1024 });
  return { observation, artifacts,
    recheck() {
      const current = inspect().filter(row => row.filePath && selectedPaths.has(row.filePath));
      if (!isDeepStrictEqual(current, selectedRows)) {
        const changes = [...new Set([...selectedRows, ...current].map(row => row.idSha256))].flatMap(id => {
          const before = selectedRows.find(row => row.idSha256 === id), after = current.find(row => row.idSha256 === id);
          if (isDeepStrictEqual(before, after)) return [];
          return [{ idSha256: id, filePath: after?.filePath ?? before?.filePath,
            fields: before && after ? Object.keys(before).filter(key =>
              !isDeepStrictEqual(before[key as keyof typeof before], after[key as keyof typeof after])) : ['population'] }];
        });
        throw new Error(`owned controller selected module observation changed: ${JSON.stringify(changes.slice(0, 20))}`);
      }
    } };
}

describe('native JSON-line pipe transport', () => {
  it('reports a recognized MCP startup cause without echoing private native error text', async () => {
    const failure = [{ method: 'mcpServer/startupStatus/updated', params: { threadId: 'thread', name: 'fixture',
      status: 'failed', error: 'HTTP 401 Unauthorized: Bearer PRIVATE_MARKER at https://private.example/secret' } }];
    const error = await waitForMcpStartup(failure, 'thread', 'fixture').catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Unauthorized, 401');
    expect(error.message).not.toMatch(/PRIVATE_MARKER|private\.example|secret/);
    await expect(waitForMcpStartup([{ method: 'mcpServer/startupStatus/updated', params: {
      threadId: 'thread', name: 'fixture', status: 'failed', error: 'PRIVATE_UNKNOWN_REASON' } }], 'thread', 'fixture'))
      .rejects.toThrow('MCP startup causes: unclassified');
  });

  it('shares an immutable process clock locally while refusing a subprocess clock as the same domain', async () => {
    expect(Object.isFrozen(processMonotonicClock)).toBe(true);
    const receipts: SuStdioReceipt[] = [];
    const clockUrl = new URL('./process-monotonic-clock.ts', import.meta.url).href;
    const child = await peer(process.execPath, ['--input-type=module', '-e', `
      import { processMonotonicClock } from ${JSON.stringify(clockUrl)};
      import { createInterface } from 'node:readline';
      createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({id:request.id,result:{
          clockId:processMonotonicClock.id,atMs:processMonotonicClock.now()
        }}) + String.fromCharCode(10));
      });
    `], {}, undefined, undefined, receipt => receipts.push(receipt));
    const observation = await child.request({ method: 'clock' });
    expect(observation.clockId).toMatch(/^process-monotonic:/);
    expect(observation.clockId).not.toBe(processMonotonicClock.id);
    expect(Number.isFinite(observation.atMs)).toBe(true);
    expect(receipts.every(receipt => receipt.clockId === processMonotonicClock.id)).toBe(true);
  });

  it('captures immutable wire values before consumers mutate them, with one clock across peers', async () => {
    const receipts: SuStdioReceipt[] = [];
    const onReceipt = (value: SuStdioReceipt) => receipts.push(value);
    const command = ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);
        process.stdout.write(JSON.stringify({id:r.id,result:{echo:r.params}})+'\\n'+
          JSON.stringify({method:'notice',params:{value:'original'}})+'\\n');
      });
    `];
    const a = await peer(process.execPath, command, {}, frame => {
      expect(receipts.at(-1)?.phase).toBe('received');
      (frame.params as RpcFrame).value = 'mutated-event';
    }, undefined, onReceipt);
    const b = await peer(process.execPath, command, {}, undefined, undefined, onReceipt);
    const frame = { method: 'turn/start', params: { value: 'original' } };
    const pending = a.request(frame);
    frame.params.value = 'mutated-input';
    const response = await pending;
    (response.echo as RpcFrame).value = 'mutated-response';
    await b.request({ method: 'initialize' });
    await vi.waitFor(() => expect(receipts.filter(r => r.phase === 'received' && r.frame.method === 'notice')).toHaveLength(2));
    expect(new Set(receipts.map(r => r.clockId)).size).toBe(1);
    expect(new Set(receipts.map(r => r.peerId)).size).toBe(2);
    for (const peerId of new Set(receipts.map(r => r.peerId))) {
      const observed = receipts.filter(r => r.peerId === peerId);
      expect(observed.map(r => r.sequence)).toEqual(observed.map((_, index) => index + 1));
      expect(observed[0].phase).toBe('write-started');
      expect(observed.some(r => r.phase === 'write-completed')).toBe(true);
      for (let i = 0; i < observed.length; i++) {
        expect(Number.isFinite(observed[i].atMs)).toBe(true);
        if (i) expect(observed[i].atMs).toBeGreaterThanOrEqual(observed[i - 1].atMs);
      }
    }
    const writes = receipts.filter(r => r.frame.method === 'turn/start');
    expect(writes.map(r => r.phase)).toEqual(['write-started', 'write-completed']);
    expect(writes.map(r => r.frame.params)).toEqual([{ value: 'original' }, { value: 'original' }]);
    expect(receipts.find(r => r.phase === 'received' && (r.frame.result as RpcFrame)?.echo)?.frame.result)
      .toEqual({ echo: { value: 'original' } });
    expect(receipts.filter(r => r.frame.method === 'notice').map(r => r.frame.params))
      .toEqual([{ value: 'original' }, { value: 'original' }]);
    expect(receipts.some(r => /provider|dispatch/.test(r.phase))).toBe(false);
    expect(a.receiptState!()).toMatchObject({ enabled: true, exited: false, sinkFailed: false });
    await a.close(); await b.close();
    for (const p of [a, b]) {
      const state = p.receiptState!();
      expect(state).toMatchObject({ exited: true, pendingWrites: 0, sinkFailed: false });
      expect(state.emitted).toBe(receipts.filter(r => r.peerId === state.peerId).length);
    }
  });

  it('fails closed before writing if the receipt sink cannot retain the attempt', async () => {
    const p = await peer(process.execPath, ['-e', `
      process.stdin.on('data',()=>process.stdout.write('unexpected-send\\n'));
    `], {}, undefined, undefined, () => { throw new Error('receipt storage unavailable'); });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('receipt storage unavailable');
    await expect(p.done).rejects.toThrow('receipt storage unavailable');
    expect(p.receiptState!()).toMatchObject({ enabled: true, sinkFailed: true, emitted: 1 });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('connection is closed');
  });

  it.each(['write-completed', 'received'] as const)('surfaces receipt failure after a possible send (%s) without replay', async phase => {
    const receipts: SuStdioReceipt[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>
        process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:{ack:true}})+'\\n'));
    `], {}, undefined, undefined, value => {
      receipts.push(value);
      if (value.phase === phase) throw new Error(`cannot retain ${phase}`);
    });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow(`cannot retain ${phase}`);
    await expect(p.done).rejects.toThrow(`cannot retain ${phase}`);
    expect(receipts.filter(r => r.phase === 'write-started')).toHaveLength(1);
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('connection is closed');
  });

  it('contains a real broken stdin pipe, rejects the request and closes without replay', async () => {
    const events: RpcFrame[] = [], receipts: SuStdioReceipt[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:fs').closeSync(0);
      process.stdout.write(JSON.stringify({method:'stdin-closed'})+'\\n');
      setInterval(()=>{},1000);
    `], {}, frame => events.push(frame), undefined, receipt => receipts.push(receipt));
    await vi.waitFor(() => expect(events.some(frame => frame.method === 'stdin-closed')).toBe(true));
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('EPIPE');
    await expect(p.done).rejects.toThrow('EPIPE');
    await p.close();
    expect(receipts.filter(r => r.frame.method === 'turn/start').map(r => r.phase)).toEqual(['write-started', 'write-failed']);
    expect(p.receiptState!()).toMatchObject({ exited: true, pendingWrites: 0 });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('connection is closed');
  });

  it('isolates the wire and later receipts from a sink mutating its own frame', async () => {
    const receipts: SuStdioReceipt[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:r.params})+'\\n');
      });
    `], {}, undefined, undefined, value => {
      receipts.push(value);
      if (value.phase === 'write-started') (value.frame.params as RpcFrame).value = 'changed-by-sink';
    });
    await expect(p.request({ method: 'turn/start', params: { value: 'wire-value' } })).resolves.toEqual({ value: 'wire-value' });
    expect(receipts.find(r => r.phase === 'write-completed')?.frame.params).toEqual({ value: 'wire-value' });
  });

  it('preserves the tracked teardown cause while redacting credentials', async () => {
    const secret = NEVER_EMIT_MARKER;
    const p = await peer(process.execPath, ['-e', `
      setInterval(()=>{},1000);
      process.stdin.on('data',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:{ready:true}})+'\\n'));
    `], { PUI_TEST_SECRET: secret });
    await p.request({ method: 'initialize' });
    processState.killFailure = `Unit pc-test.scope not loaded; credential=${secret}`;
    try {
      const failure = await p.close().catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Unit pc-test.scope not loaded');
      expect((failure as Error).message).not.toContain(secret);
    } finally {
      peers.splice(peers.indexOf(p), 1);
      await p.done;
    }
  });

  // WI-10004247: an explicit SIGKILL reported `incomplete` (a D-state
  // process outlived the verification window) is a delivered kill, not a
  // refused one. Close succeeds once the engine itself exits; the calibration
  // keeps a genuinely refused kill failing.
  it('closes when a delivered SIGKILL reports incomplete, and still fails a refused kill', async () => {
    const script = `
      setInterval(()=>{},1000);
      process.stdin.on('data',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:{ready:true}})+'\\n'));
    `;
    const pending = await peer(process.execPath, ['-e', script]);
    await pending.request({ method: 'initialize' });
    processState.killFailure = 'scope pc-test.scope signalled SIGKILL but 1 process(es) still alive after the verification window';
    processState.killError = 'incomplete';
    await expect(pending.close()).resolves.toBeUndefined();
    const refused = await peer(process.execPath, ['-e', script]);
    await refused.request({ method: 'initialize' });
    processState.killError = 'command_failed';
    try {
      const failure = await refused.close().catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Structured engine teardown failed: command_failed');
    } finally {
      peers.splice(peers.indexOf(refused), 1);
      await refused.done;
    }
  });

  it('separates responses, notifications and server requests across fragmented writes', async () => {
    const events: RpcFrame[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line); const frames=JSON.stringify({id:r.id,result:{ack:true}})+'\\n'+
          JSON.stringify({method:'item/started',params:{id:'tool'}})+'\\n'+
          JSON.stringify({id:'server-request',method:'ask',params:{}})+'\\n';
        process.stdout.write(frames.slice(0,8));setTimeout(()=>process.stdout.write(frames.slice(8)),5);
      });
    `], {}, (frame) => events.push(frame));
    await expect(p.request({ method: 'turn/start' })).resolves.toEqual({ ack: true });
    await vi.waitFor(() => expect(events).toEqual([
      { method: 'item/started', params: { id: 'tool' } }, { id: 'server-request', method: 'ask', params: {} },
    ]));
  });

  it('reports native refusal and unknown delivery without sending again', async () => {
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line); if(r.type==='refuse') process.stdout.write(JSON.stringify({type:'response',id:r.id,success:false,error:'refused'})+'\\n');
      });
    `]);
    await expect(p.request({ type: 'refuse' })).rejects.toThrow('refused');
    await expect(p.request({ type: 'unknown' }, 40)).rejects.toThrow('delivery is unknown');
  });

  it('fails outstanding requests when a peer emits corrupt protocol', async () => {
    const p = await peer(process.execPath, ['-e', "process.stdin.once('data',()=>process.stdout.write('not json\\n'))"]);
    await expect(p.request({ method: 'initialize' })).rejects.toThrow();
    await expect(p.done).rejects.toThrow();
  });

  it('retains a bounded startup diagnostic and redacts credentials split across stderr writes', async () => {
    const secret = NEVER_EMIT_MARKER;
    const p = await peer(process.execPath, ['-e', `
      process.stdin.once('data',()=>{
        const secret=process.env.PUI_TEST_SECRET;
        process.stderr.write('x'.repeat(20000)+'\\nNative config refused\\nAuthorization: Bearer '+secret.slice(0,12));
        setTimeout(()=>process.stderr.write(secret.slice(12)+'\\n',()=>process.exit(7)),5);
      });
    `], { PUI_TEST_SECRET: secret });
    const failure = await p.request({ method: 'initialize' }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('Native config refused');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThanOrEqual(3000);
    await expect(p.done).rejects.toThrow('Native config refused');
  });
});

describe('owned Node loader observations', () => {
  it('binds retained controller transforms and refuses selected cache drift without treating mocks as source', () => {
    const home = mkdtempSync(join(tmpdir(), 'carry-controller-')); homes.push(home);
    const driver = fileURLToPath(import.meta.url);
    const transport = fileURLToPath(new URL('./su-session-stdio-peer.ts', import.meta.url));
    const modules = new Map([...controllerModules()].map(([id, node]) => [id, { ...node, meta: { ...node.meta } }]));
    const probe = controllerLoaderProbe(home, 'controller', [driver, transport].map((filePath, i) => ({
      id: `source-${i}`, filePath, maxBytes: 1024 * 1024,
    })), modules);
    expect(probe.observation.unmatchedPaths).toEqual([]);
    const transformed = probe.observation.selectedRows.filter(row => row.kind === 'transformed');
    expect(transformed.map(row => row.filePath)).toEqual(expect.arrayContaining([realpathSync(driver), realpathSync(transport)]));
    expect(transformed.every(row => row.evaluationSettled)).toBe(true);
    expect(probe.observation.rows.some(row => row.kind === 'mocked')).toBe(true);
    expect(probe.observation.rows.some(row => row.kind === 'external')).toBe(true);
    for (const row of transformed) {
      const artifact = probe.artifacts.find(a => a.id === `controller-transform-${row.idSha256}`)!;
      const code = readFileSync(artifact.filePath, 'utf8');
      expect(createHash('sha256').update(code).digest('hex')).toBe(row.transformedSha256);
      expect(row.transformedSha256).not.toBe(createHash('sha256').update(readFileSync(row.filePath!)).digest('hex'));
    }
    expect(JSON.stringify(probe.observation)).not.toContain(NEVER_EMIT_MARKER);
    probe.recheck();
    const node = [...modules.values()].find(node => node.meta?.file === transport && typeof node.meta.code === 'string')!;
    node.meta!.code += '\n// changed after observation';
    expect(() => probe.recheck()).toThrow('owned controller selected module observation changed');
    const unknownPath = join(home, 'not-imported.js'); writeFileSync(unknownPath, 'export default 1;');
    expect(controllerLoaderProbe(home, 'unmatched', [{ id: 'unknown', filePath: unknownPath, maxBytes: 1024 }]).observation.unmatchedPaths)
      .toEqual([unknownPath]);
    expect(() => controllerLoaderProbe(home, 'overflow', [], new Map(Array.from({ length: 8193 }, (_, i) =>
      [String(i), { id: String(i), imports: new Set<string>() }])))).toThrow('population exceeds bound');
  });

  it('rejects an overflowed trace even when the observed program catches the loader refusal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'carry-loader-bound-')); homes.push(home);
    const loader = nodeLoaderProbe(home, 'bounded');
    const p = await peer(process.execPath, ['--input-type=module', '-e', `
      import { createInterface } from 'node:readline';
      let failure = null;
      for (let index = 0; index < 2100; index++) {
        try { await import('data:text/javascript,export default 1#' + index); }
        catch (error) { failure = error.message; break; }
      }
      createInterface({input:process.stdin}).on('line', line => process.stdout.write(
        JSON.stringify({id:JSON.parse(line).id,result:{failure}}) + '\\n'));
    `], loader.env, undefined, undefined, undefined, home);
    expect(await p.request({ method: 'ready' })).toEqual({ failure: 'owned loader trace bound exceeded' });
    await p.close();
    expect(() => loader.read(p.pid()!)).toThrow();
    const text = readFileSync(loader.tracePath, 'utf8');
    expect(text).toContain('"phase":"overflow"');
    expect(text).not.toContain('export default');
  });

  it('records the executed import/require export branches and preserves private failure boundaries', async () => {
    const home = mkdtempSync(join(tmpdir(), 'carry-loader-')); homes.push(home);
    const packagePath = join(home, 'node_modules', 'carry-probe');
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ name: 'carry-probe', type: 'module',
      exports: { '.': { import: './import.mjs', require: './require.cjs' } } }));
    writeFileSync(join(packagePath, 'import.mjs'), 'export default "import branch";');
    writeFileSync(join(packagePath, 'require.cjs'), 'module.exports = "require branch";');
    const loader = nodeLoaderProbe(home, 'conditional');
    const p = await peer(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { createInterface } from 'node:readline';
      const require = createRequire(import.meta.url);
      const imported = (await import('carry-probe')).default;
      const required = require('carry-probe');
      let failure;
      try { await import('carry-probe/never-emit-me'); } catch (error) { failure = error.code; }
      createInterface({input:process.stdin}).on('line', line => process.stdout.write(
        JSON.stringify({id:JSON.parse(line).id,result:{imported,required,failure}}) + '\\n'));
    `], loader.env, undefined, undefined, undefined, home);
    expect(await p.request({ method: 'ready' })).toEqual({ imported: 'import branch', required: 'require branch',
      failure: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await p.close();
    const rows = loader.read(p.pid()!);
    expect(rows.find(row => row.phase === 'resolve' && row.filePath === join(packagePath, 'import.mjs')))
      .toMatchObject({ outcome: 'resolved', conditions: expect.arrayContaining(['import']) });
    expect(rows.find(row => row.phase === 'resolve' && row.filePath === join(packagePath, 'require.cjs')))
      .toMatchObject({ outcome: 'resolved', conditions: expect.arrayContaining(['require']) });
    expect(rows.filter(row => row.phase === 'load').map(row => row.filePath)).toEqual(expect.arrayContaining([
      join(packagePath, 'import.mjs'), join(packagePath, 'require.cjs'),
    ]));
    expect(rows.find(row => row.phase === 'load' && row.filePath === join(packagePath, 'import.mjs'))!.sourceSha256)
      .toBe(createHash('sha256').update(readFileSync(join(packagePath, 'import.mjs'))).digest('hex'));
    expect(rows.some(row => row.phase === 'resolve' && row.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(NEVER_EMIT_MARKER);
  });
});

it('rejects incomplete syscall evidence and preserves descriptor parsing residue', () => {
  const home = mkdtempSync(join(tmpdir(), 'carry-syscall-parser-')); homes.push(home);
  const trace = syscallFileProbe(home, 'parse');
  const complete = '1 read(3</input>, ""..., 1) = 1\n1 +++ exited with 0 +++\n';
  expect(() => trace.parse(complete.trimEnd())).toThrow('incomplete owned syscall trace');
  expect(() => trace.parse(complete.replace('1 +++ exited with 0 +++\n', ''))).toThrow('incomplete owned syscall lifecycle');
  expect(() => trace.parse('1 read(3</input>,  <unfinished ...>\n1 +++ exited with 0 +++\n'))
    .toThrow('incomplete owned syscall lifecycle');
  expect(() => trace.parse('1 <... read resumed>"", 1) = 1\n1 +++ exited with 0 +++\n'))
    .toThrow('unmatched owned syscall continuation');
  expect(() => trace.parse('1 read(3</input>, "", 1) = 1\n1 +++ killed by SIGXFSZ +++\n'))
    .toThrow('incomplete owned syscall result');
  expect(() => trace.parse(complete + '1 close(3</input>) = 0\n')).toThrow('owned syscall row after exit');
  expect(() => trace.parse('x'.repeat(8 * 1024 * 1024) + '\n')).toThrow('incomplete owned syscall trace');
  const resumed = trace.parse('1 read(3</input>,  <unfinished ...>\n1 <... read resumed>""..., 1) = 1\n1 +++ exited with 0 +++\n');
  expect(resumed.accesses).toEqual([{ tid: 1, syscall: 'read', filePath: '/input', result: '1' }]);
  expect(trace.parse('1 openat(AT_FDCWD, ""..., O_RDONLY) = 3</input>\n1 +++ exited with 0 +++\n').accesses).toEqual([]);
  const residue = trace.parse('1 openat(AT_FDCWD, ""..., O_RDONLY) = 3</dev/null<char 1:3>>\n' +
    '1 read(3</dev/null<char 1:3>>, ""..., 1) = 1\n1 read(3</input (deleted)>, ""..., 1) = 1\n' +
    '1 read(3</input>, "", 1) = -1 EIO (Input/output error)\n1 +++ exited with 0 +++\n');
  expect(residue).toMatchObject({ accesses: [], unavailableLabels: 2, failedCalls: 1 });
});

describe.skipIf(process.env.PUI_NATIVE_PROTOCOL !== '1')('installed native protocol startup', () => {
  it('observes owned file reads without recording buffers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'carry-syscalls-')); homes.push(home);
    const filePath = join(home, 'input.bin');
    writeFileSync(filePath, NEVER_EMIT_MARKER.repeat(100));
    const trace = syscallFileProbe(home, 'read');
    const launch = trace.launch(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync('input.bin', 'r');
      const buffer = Buffer.alloc(32);
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.readvSync(fd, [buffer, Buffer.alloc(16)], 0);
      fs.closeSync(fd);
      require('node:readline').createInterface({ input: process.stdin }).on('line', line =>
        process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, result: {} }) + '\\n'));
    `]);
    const p = await peer(launch.binary, launch.args, {}, undefined, undefined, undefined, home);
    await p.request({ method: 'ready' }); await p.close();
    const raw = readFileSync(trace.tracePath, 'utf8'), observation = trace.read();
    expect(raw.includes(NEVER_EMIT_MARKER), 'syscall trace must not record private buffers').toBe(false);
    expect(observation.accesses.filter(row => row.filePath === filePath).map(row => row.syscall))
      .toEqual(expect.arrayContaining(['pread64', 'preadv']));
    expect(observation.accesses.some(row => row.syscall === 'mmap')).toBe(true);
  }, 30_000);

  it('observes installed native startup data reads through process exit without provider inference', async () => {
    const home = mkdtempSync(join(tmpdir(), 'carry-native-syscalls-')); homes.push(home);
    const trace = syscallFileProbe(home, 'native');
    const launch = trace.launch('codex', ['app-server', '-c', 'features.shell_snapshot=false', '-c', 'features.shell_tool=false',
      '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false']);
    const p = await peer(launch.binary, launch.args, {}, undefined,
      'web_search = "disabled"\n', undefined, home);
    await p.request({ method: 'initialize', params: { clientInfo: { name: 'unpaid_file_observation', version: '1' } } });
    p.send({ method: 'initialized', params: {} });
    await p.close();
    const observation = trace.read();
    expect(observation.accesses.some(row => row.syscall === 'read' && row.filePath === join(home, 'config.toml'))).toBe(true);
    expect(new Set(observation.accesses.filter(row => row.filePath === join(home, 'config.toml')).map(row => row.tid)).size)
      .toBeGreaterThan(0);
    expect(observation.evidenceKind).toBe('observation-only');
    expect(observation.unresolved.length).toBeGreaterThan(0);
    console.info('CARRY_NATIVE_SYSCALL_OBSERVATION', JSON.stringify({ traceSha256: observation.traceSha256,
      traceBytes: observation.traceBytes, tracedTasks: observation.tracedTaskIds.length,
      fileReadCalls: observation.accesses.filter(row => row.syscall !== 'mmap').length,
      mappedFileCalls: observation.accesses.filter(row => row.syscall === 'mmap').length,
      unavailableLabels: observation.unavailableLabels, failedCalls: observation.failedCalls }));
  }, 30_000);

  it('observes the installed native runtime before opening a thread without provider inference', async () => {
    // This fixture observes only the idle core runtime. Freeze its launch
    // without optional shell/plugin startup work; the default native startup
    // was measured spawning git/git-remote-http while the census ran. This
    // configuration is fixture-only, never a production policy change.
    const p = await peer('codex', ['app-server', '-c', 'features.shell_snapshot=false', '-c', 'features.shell_tool=false',
      '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false']);
    await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_runtime_inventory_test', version: '1' } } });
    // No thread or inference request. Thread startup legitimately spawns
    // transient children; a frozen live PID tree is not a run admission gate.
    const runtime = await captureCarryRuntimeSnapshot(p.pid()!);
    expect(runtime.rootPid).toBe(p.pid());
    expect(runtime.processes.some(process => process.pid === p.pid())).toBe(true);
    expect(runtime.processes.some(process => /\/codex$/.test(process.executable))).toBe(true);
    expect(runtime.artifacts.some(a => /\/codex$/.test(a.filePath))).toBe(true);
    expect(runtime.processes.every(p => p.mappedFiles.includes(p.executable))).toBe(true);
    await recheckCarryRuntimeSnapshot(runtime);
    expect(runtime.evidenceKind).toBe('observation-only');
  }, 30_000);

  it.each([false, true])('does not mistake accepted output-limit configuration for native enforcement (configured %s)', async configured => {
    const requests: Array<Record<string, unknown>> = [], events: RpcFrame[] = [];
    const requestedLimit = 16;
    // This scripted result intentionally exceeds the proposed bound. Its usage
    // is fixture data, not a measurement of provider tokens or provider limits.
    const reply = 'offline unbounded response '.repeat(256);
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
        text: reply, inputTokens: 100, outputTokens: 2048 })));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const config = stringifyToml({
        model_provider: 'cache_protocol_probe',
        model_providers: { cache_protocol_probe: { name: 'Local protocol fixture',
          base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: 'responses', requires_openai_auth: false,
          supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled',
        // Neither spelling is a documented Codex output-limit setting. Test
        // the tempting assumption explicitly: a readable config is not proof
        // that the native request contains, or the client enforces, a bound.
        ...(configured ? { model_max_output_tokens: requestedLimit, max_output_tokens: requestedLimit } : {}),
      } as Parameters<typeof stringifyToml>[0]);
      p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config);
      await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_cache_output_bound_test', version: '1' } } });
      p.send({ method: 'initialized', params: {} });
      const start = await p.request({ method: 'thread/start', params: { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
      const threadId = String((start.thread as RpcFrame).id);
      const turn = await p.request({ method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'Offline native output-bound counterexample.' }],
      } });
      const turnId = String((turn.turn as RpcFrame).id);
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        method: 'turn/completed', params: expect.objectContaining({ threadId,
          turn: expect.objectContaining({ id: turnId, status: 'completed' }) }),
      })), { timeout: 20_000 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('max_output_tokens');
      expect(requests[0]).not.toHaveProperty('max_completion_tokens');
      const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
      const trace = inspectCarryNativeTurn({ threadId, turnId, events, threadRead, allowedMcpCalls: [] });
      expect(trace.status).toBe('verified');
      const items = ((threadRead.thread as RpcFrame).turns as RpcFrame[])[0].items as RpcFrame[];
      expect(items.find(item => item.type === 'agentMessage')?.text).toBe(reply);
      // Exact completed output, not just HTTP receipt, falsifies client-side
      // clipping for these settings. No output-bound receipt may be minted.
      expect(reply.length).toBeGreaterThan(requestedLimit * 100);
    } finally {
      try {
        if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); }
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);

  it.skipIf(process.env.PUI_NATIVE_PLATFORM_MCP !== '1').each([false, true])(
    'resolves the inherited platform caller through native MCP without provider inference (preauthorized %s)', async preauthorized => {
    // Explicit opt-in uses ONLY this session's existing MCP bearer and client.
    // Never copy its provider/auth.json, hooks, instructions, or model routing.
    const inherited = parseToml(readFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8'));
    const mcp = (inherited.mcp_servers as Record<string, Record<string, unknown>>)['papercusp-su'];
    const url = new URL(String(mcp.url));
    expect(url.searchParams.get('client')).toBe(process.env.PAPERCUSP_SID);
    expect(typeof (mcp.http_headers as Record<string, unknown>)?.Authorization === 'string').toBe(true);
    const events: RpcFrame[] = [], requests: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString()); requests.push(request);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests.length === 1) {
          // Use the name actually advertised by this installed client. A
          // guessed/flattened name is not evidence of a successful MCP call.
          const namespace = request.tools.find((entry: Record<string, unknown>) => entry.type === 'namespace' &&
            (entry.tools as Array<Record<string, unknown>>).some(tool => tool.name === 'tools_invoke'));
          if (!namespace) throw new Error('Native tools_invoke namespace missing');
          const item = { id: 'fc_identity', type: 'function_call', call_id: 'identity-call',
            namespace: namespace.name, name: 'tools_invoke',
            arguments: JSON.stringify({ name: 'coord:whoami', args: {} }), status: 'completed' };
          const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 0, outputTokens: 0 }), output: [item] };
          const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
          res.end(event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
            event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
        } else {
          res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
            text: '{"offline":true}', inputTokens: 0, outputTokens: 0 })));
        }
      } catch { errors.push('Local scripted response failed'); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const config = stringifyToml({
        model_provider: 'cache_protocol_probe',
        model_providers: { cache_protocol_probe: { name: 'Local protocol fixture',
          base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: 'responses', requires_openai_auth: false,
          supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled',
        // Filters and native receipts use the original MCP name, whereas the
        // Responses function name is normalized to tools_invoke.
        mcp_servers: { 'papercusp-su': { url: String(mcp.url), http_headers: mcp.http_headers,
          enabled_tools: ['tools:invoke'],
          ...(preauthorized ? { tools: { 'tools:invoke': { approval_mode: 'approve' } } } : {}) } },
      } as Parameters<typeof stringifyToml>[0]);
      p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config);
      await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_cache_identity_test', version: '1' } } });
      p.send({ method: 'initialized', params: {} });
      const start = await p.request({ method: 'thread/start', params: { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
      const threadId = String((start.thread as RpcFrame).id);
      await waitForMcpStartup(events, threadId, 'papercusp-su');
      const before = await p.request({ method: 'config/read', params: { cwd: homes.at(-1), includeLayers: true } });
      const inventory = await p.request({ method: 'mcpServerStatus/list', params: { threadId, detail: 'toolsAndAuthOnly' } });
      expect(inventory.nextCursor == null).toBe(true);
      const entries = inventory.data as Array<Record<string, unknown>>;
      expect(entries.map(entry => entry.name)).toEqual(['papercusp-su']);
      expect(entries[0].toolsError == null).toBe(true);
      expect(entries[0].authStatus).toBe('bearerToken');
      expect(entries[0].runtimeStatus).toBe('connected');
      expect(Object.keys(entries[0].tools as object), JSON.stringify({ auth: entries[0].authStatus,
        runtime: entries[0].runtimeStatus, names: Object.keys(entries[0].tools as object).filter(name => /invoke/.test(name)) }))
        .toHaveLength(1);
      const response = await p.request({ method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'Offline native identity receipt fixture.' }],
      } });
      const turnId = String((response.turn as RpcFrame).id);
      await vi.waitFor(() => expect(events.some(frame => frame.method === 'turn/completed' &&
        (frame.params as RpcFrame)?.threadId === threadId)).toBe(true), { timeout: 30_000 });
      const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
      const trace = inspectCarryNativeTurn({ threadId, turnId, events, threadRead,
        allowedMcpCalls: [{ server: 'papercusp-su', tool: 'tools:invoke', arguments: { name: 'coord:whoami', args: {} } }] });
      const items = ((threadRead.thread as RpcFrame).turns as RpcFrame[])[0].items as RpcFrame[];
      const call = items.find(item => item.type === 'mcpToolCall')!;
      const credential = String((mcp.http_headers as Record<string, unknown>).Authorization).replace(/^Bearer /, '');
      expect(trace.status, JSON.stringify({ missing: trace.missing, violations: trace.violations, call })
        .replaceAll(credential, '[redacted]')).toBe(preauthorized ? 'verified' : 'incomplete');
      if (preauthorized) {
        const content = (call.result as RpcFrame).content as Array<{ type: string; text?: string }>;
        const identities = content.flatMap(block => {
          try { const value = JSON.parse(block.text ?? ''); return value.ownerId ? [value] : []; } catch { return []; }
        });
        expect(identities).toHaveLength(1);
        expect(identities[0].ownerId).toBe(process.env.PAPERCUSP_SID);
        expect(identities[0].workspaceId).toBe(process.env.PAPERCUSP_WORKSPACE);
        expect(JSON.stringify(requests.at(-1)?.input).includes(process.env.PAPERCUSP_SID!)).toBe(true);
      } else {
        expect(call.result).toBeNull();
        expect((call.error as RpcFrame).message).toBe('MCP tool call requires approval, but approval policy is never');
      }
      // Compare as booleans: a failed assertion must never print bearer-bearing
      // native configuration, either on stdout or in the test-run ledger.
      const after = await p.request({ method: 'config/read', params: { cwd: homes.at(-1), includeLayers: true } });
      expect(isDeepStrictEqual(before, after)).toBe(true);
      const afterInventory = await p.request({ method: 'mcpServerStatus/list', params: { threadId, detail: 'toolsAndAuthOnly' } });
      expect(isDeepStrictEqual(inventory, afterInventory)).toBe(true);
      expect(requests).toHaveLength(2);
      expect(errors).toEqual([]);
      console.info('CARRY_NATIVE_IDENTITY_RECEIPT', JSON.stringify({ threadId, turnId, preauthorized,
        ownerId: preauthorized ? process.env.PAPERCUSP_SID : null,
        workspaceId: preauthorized ? process.env.PAPERCUSP_WORKSPACE : null,
        configSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
        toolInventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
        nativeAuthStatus: entries[0].authStatus, nativeRuntimeStatus: entries[0].runtimeStatus,
        scriptedRequests: requests.length, providerInference: false }));
    } finally {
      try { if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); } }
      finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  }, 90_000);

  for (const platform of [false, true]) {
  it.skipIf(platform && process.env.PUI_NATIVE_PLATFORM_MCP !== '1').each(platform ? [true] : [false, true])(
    `cross-checks completed native item receipts against persisted history without provider inference (platform ${platform}, source read %s)`, async readSource => {
    const events: RpcFrame[] = [];
    const protocolReceipts: SuStdioReceipt[] = [];
    const recipe = createCarryTrialRecipe(), task = recipe.tasks.find(t => t.id === 'T1')!;
    // Scripted answer tests the controller/native/oracle seam, not model
    // correctness or carried-fact recovery. The source cases below retain
    // their separate attributed byte-window witness.
    const expectedResponse = readSource ? '{"offline":true}' : JSON.stringify(task.expected);
    const fixtureHome = mkdtempSync(join(tmpdir(), 'carry-source-receipt-')); homes.push(fixtureHome);
    let predecessor: CarrySourceSnapshot | undefined;
    const window = Buffer.from('cedar-48f6e9a2');
    let readArgs = { file_path: '', byte_offset: 0, byte_limit: window.length };
    const observedReads: unknown[] = [], httpErrors: unknown[] = [], mcpHosts: McpServer[] = [];
    const providerCalls: Array<Record<string, unknown>> = [];
    const serverName = platform ? 'papercusp-su' : 'cache_receipts';
    const toolName = platform ? 'tools:invoke' : 'capability_read';
    let functionNamespace = 'mcp__cache_receipts';
    const identityArgs = { name: 'coord:whoami', args: {} };
    const sourceArgs = () => platform ? { name: 'capability:read', args: readArgs } : readArgs;
    let privateMcpConfig: string | undefined;
    if (platform) {
      const inherited = parseToml(readFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8'));
      const mcp = (inherited.mcp_servers as Record<string, Record<string, unknown>>)['papercusp-su'];
      expect(new URL(String(mcp.url)).searchParams.get('client')).toBe(process.env.PAPERCUSP_SID);
      expect(typeof (mcp.http_headers as Record<string, unknown>)?.Authorization === 'string').toBe(true);
      privateMcpConfig = stringifyToml({ mcp_servers: { 'papercusp-su': {
        url: mcp.url, http_headers: mcp.http_headers, enabled_tools: ['tools:invoke'],
        tools: { 'tools:invoke': { approval_mode: 'approve' } },
      } } } as Parameters<typeof stringifyToml>[0]);
    }
    let requests = 0, preparationRequests = 0, preparingSource = readSource;
    const server = createServer(async (req, res) => {
      if (req.url === '/mcp') {
        const host = new McpServer({ name: 'carry-receipt-fixture', version: '1' }); mcpHosts.push(host);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
          expect(req.headers.authorization).toBe('Bearer offline-fixture');
          host.registerTool('capability_read', {
            inputSchema: { file_path: z.string(), byte_offset: z.number(), byte_limit: z.number() },
            annotations: { readOnlyHint: true },
          }, async args => {
            observedReads.push(args);
            // Real platform byte-window writer; only network/auth are fixtures.
            return await sourceReadTool.handler(args as never, { projectDir: fixtureHome } as never) as {
              content: Array<{ type: 'text'; text: string }>;
            };
          });
          await host.connect(transport);
          await transport.handleRequest(req, res);
        } catch (error) {
          httpErrors.push(error);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      providerCalls.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (preparingSource) preparationRequests++; else requests++;
      if (readSource && !preparingSource && requests <= (platform ? 2 : 1)) {
        if (platform) {
          const namespaces = providerCalls.at(-1)?.tools as Array<Record<string, unknown>>;
          const namespace = namespaces.find(entry => entry.type === 'namespace' &&
            (entry.tools as Array<Record<string, unknown>>).some(tool => tool.name === 'tools_invoke'));
          if (!namespace) { httpErrors.push('Missing native dispatcher namespace'); res.writeHead(500); res.end(); return; }
          functionNamespace = String(namespace.name);
        }
        const identity = platform && requests === 1;
        const item = { id: identity ? 'fc_identity' : 'fc_source', type: 'function_call',
          call_id: identity ? 'identity-call' : 'source-read-call', namespace: functionNamespace,
          name: platform ? 'tools_invoke' : 'capability_read',
          arguments: JSON.stringify(identity ? identityArgs : sourceArgs()), status: 'completed' };
        const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 0, outputTokens: 0 }), output: [item] };
        const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
          event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
        return;
      }
      // Existing production SSE serializer, scripted local text only. These
      // zero fixture counters are never recorded as real provider usage.
      const body = codexCliResponsesBody({ model: preparingSource ? 'gpt-6-luna' : 'gpt-6-sol',
        text: preparingSource ? JSON.stringify(recipe.sourcePreparation.expectedAcknowledgement) : expectedResponse, inputTokens: 0, outputTokens: 0 });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const overrides = {
        model_provider: 'cache_protocol_probe',
        model_reasoning_effort: 'medium',
        'model_providers.cache_protocol_probe.name': 'Local protocol fixture',
        'model_providers.cache_protocol_probe.base_url': `http://127.0.0.1:${address.port}/v1`,
        'model_providers.cache_protocol_probe.wire_api': 'responses',
        'model_providers.cache_protocol_probe.requires_openai_auth': false,
        'model_providers.cache_protocol_probe.supports_websockets': false,
        'model_providers.cache_protocol_probe.request_max_retries': 0,
        'model_providers.cache_protocol_probe.stream_max_retries': 0,
        'features.apps': false, 'features.shell_tool': false, web_search: 'disabled',
        ...(readSource && !platform ? {
          'mcp_servers.cache_receipts.url': `http://127.0.0.1:${address.port}/mcp`,
          'mcp_servers.cache_receipts.http_headers.Authorization': 'Bearer offline-fixture',
        } : {}),
      };
      const nativeTurn = async () => {
        const expectedModel = preparingSource ? 'gpt-6-luna' : 'gpt-6-sol';
        p = await peer('codex', ['app-server', ...Object.entries(overrides).flatMap(([key, value]) =>
          ['-c', `${key}=${JSON.stringify(value)}`])], {}, frame => events.push(frame), privateMcpConfig,
        receipt => protocolReceipts.push(receipt));
        await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_cache_trace_test', version: '1' } } });
        p.send({ method: 'initialized', params: {} });
        const start = await p.request({ method: 'thread/start', params: {
          model: expectedModel, modelProvider: 'cache_protocol_probe', cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only',
        } });
        expect(start.model).toBe(expectedModel);
        const threadId = String((start.thread as RpcFrame).id);
        if (readSource) await waitForMcpStartup(events, threadId, serverName);
        const nativeConfig = await captureCarryNativeConfiguration(p, { threadId, cwd: homes.at(-1)!,
          servers: readSource ? [{ name: serverName, tools: [toolName], authStatus: 'bearerToken' }] : [] });
        const manifest = await captureCarryArtifactManifest({
          protocolRef: 'installed-native-loopback-fixture:no-provider-inference', configuration: nativeConfig,
          dependencyScope: {
            recipeSha256: recipe.sha256,
            roots: [{ role: 'instrument', artifactIds: ['task-and-checker'] },
              { role: 'task', artifactIds: ['recipe-and-response-oracle'] },
              { role: 'seed', artifactIds: ['recipe-and-response-oracle'] },
              { role: 'checker', artifactIds: ['task-and-checker', 'recipe-and-response-oracle'] }],
            nodes: [
              { artifactId: 'task-and-checker', dependsOn: ['peer-executable', 'transport', 'capture', 'recipe-and-response-oracle', 'observation-clock'] },
              { artifactId: 'peer-executable', dependsOn: [] }, { artifactId: 'transport', dependsOn: ['observation-clock'] },
              { artifactId: 'capture', dependsOn: ['recipe-and-response-oracle'] },
              { artifactId: 'recipe-and-response-oracle', dependsOn: [] },
              { artifactId: 'observation-clock', dependsOn: [] },
            ],
            unresolved: ['fixture declares selected imports only; transitive JS and native dependencies are not censused',
              'default-run shell/plugin and transient/unloaded runtime scope remains unmeasured'],
          },
          artifacts: [
            // This is the launched peer's executable, not an assertion that a
            // wrapper's subprocesses or dynamic dependencies were censused.
            { id: 'peer-executable', filePath: `/proc/${p.pid()}/exe`, maxBytes: 512 * 1024 * 1024 },
            { id: 'task-and-checker', filePath: fileURLToPath(import.meta.url), maxBytes: 1024 * 1024 },
            { id: 'transport', filePath: fileURLToPath(new URL('./su-session-stdio-peer.ts', import.meta.url)), maxBytes: 1024 * 1024 },
            { id: 'observation-clock', filePath: fileURLToPath(new URL('./process-monotonic-clock.ts', import.meta.url)), maxBytes: 1024 * 1024 },
            { id: 'capture', filePath: fileURLToPath(new URL('./launch-cost/scan-launch-transcripts.ts', import.meta.url)), maxBytes: 1024 * 1024 },
            { id: 'recipe-and-response-oracle', filePath: fileURLToPath(new URL('./launch-cost/launch-cost-metrics.ts', import.meta.url)), maxBytes: 1024 * 1024 },
          ],
        });
        expect(manifest.evidenceKind).toBe('observation-only');
        expect(manifest.dependencyScope!.evidenceKind).toBe('declaration-only');
        expect(manifest.dependencyScope!.missingRoles).toEqual(['launcher', 'native-runtime', 'scripts', 'source', 'pricing']);
        expect(manifest.configuration.threadId).toBe(threadId);
        const inputText = preparingSource ? recipe.sourcePreparation.prompt : readSource ? 'Offline native receipt fixture.' : task.prompt;
        const response = await p.request({ method: 'turn/start', params: {
          threadId, input: [{ type: 'text', text: inputText }],
        } });
        const turnId = String((response.turn as RpcFrame).id);
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
          method: 'turn/completed', params: expect.objectContaining({ threadId,
            turn: expect.objectContaining({ id: turnId, status: 'completed' }) }),
        })), { timeout: 20_000 });
        const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
        const writes = protocolReceipts.filter(r => r.phase === 'write-started' && r.frame.method === 'turn/start' &&
          (r.frame.params as RpcFrame).threadId === threadId);
        expect(writes).toHaveLength(1);
        const ack = protocolReceipts.find(r => r.phase === 'received' && r.peerId === writes[0].peerId &&
          r.frame.id === writes[0].frame.id);
        expect(((ack?.frame.result as RpcFrame)?.turn as RpcFrame)?.id).toBe(turnId);
        const completed = protocolReceipts.filter(r => r.phase === 'received' && r.frame.method === 'turn/completed' &&
          (r.frame.params as RpcFrame).threadId === threadId && ((r.frame.params as RpcFrame).turn as RpcFrame).id === turnId);
        expect(completed).toHaveLength(1);
        expect(completed[0].atMs).toBeGreaterThanOrEqual(writes[0].atMs);
        // Check the actual native requests, including tool continuations, not
        // a model name in the prompt or scripted assistant self-identification.
        // This is client-side phase provenance only; the local endpoint has no
        // serving account and cannot establish real T5 provider correlation.
        expect(providerCalls.length).toBeGreaterThan(0);
        for (const call of providerCalls) {
          expect(call).toMatchObject({ model: expectedModel, reasoning: { effort: 'medium' } });
          const metadata = JSON.parse((call.client_metadata as Record<string, string>)['x-codex-turn-metadata']);
          expect(metadata).toMatchObject({ thread_id: threadId, turn_id: turnId });
        }
        await recheckCarryArtifactManifest(manifest, p);
        return { threadId, turnId, threadRead, inputText, rpcWrite: writes[0], completed: completed[0] };
      };
      let sourceCompleted: SuStdioReceipt | undefined;
      if (readSource) {
        const prepared = await nativeTurn();
        const preparationTrace = inspectCarryNativeTurn({ threadId: prepared.threadId, turnId: prepared.turnId,
          threadRead: prepared.threadRead, events, allowedMcpCalls: [], expectedInputText: recipe.sourcePreparation.prompt });
        expect(preparationTrace).toMatchObject({ status: 'verified', inputSha256: recipe.sourcePreparation.promptSha256,
          mcpItemIds: [], missing: [], violations: [] });
        expect(inspectCarryPreparationResponse(preparationTrace.finalResponse!)).toMatchObject({
          evidenceKind: 'response-only', matches: true, recipeSha256: recipe.sha256 });
        sourceCompleted = prepared.completed;
        predecessor = await captureCompletedCarrySource(p!, prepared.threadId, prepared.turnId);
        peers.splice(peers.indexOf(p!), 1); p = undefined;
        const byteOffset = predecessor.snapshot.bytes.indexOf(window);
        expect(byteOffset).toBeGreaterThan(0);
        readArgs = { file_path: predecessor.filePath, byte_offset: byteOffset, byte_limit: window.length };
        await recheckCarrySourceSnapshot(predecessor);
        preparingSource = false; events.length = 0; providerCalls.length = 0;
      }
      const { threadId, turnId, threadRead, inputText, rpcWrite, completed } = await nativeTurn();
      if (readSource) {
        // Native Codex received the platform result and returned it to the
        // next local provider request, not just a successful tools/list.
        expect(providerCalls[0]?.tools).toContainEqual(expect.objectContaining({ type: 'namespace', name: functionNamespace,
          tools: expect.arrayContaining([expect.objectContaining({ type: 'function', name: platform ? 'tools_invoke' : 'capability_read' })]) }));
        expect(JSON.stringify(providerCalls.at(-1)?.input), JSON.stringify({
          outputs: (providerCalls.at(-1)?.input as Array<Record<string, unknown>>)?.filter(item => item.type === 'function_call_output') }))
          .toContain(window.toString('base64'));
      }
      const evidence = { threadId, turnId, events, threadRead, expectedInputText: inputText, allowedMcpCalls: readSource
        ? [...(platform ? [{ server: serverName, tool: toolName, arguments: identityArgs }] : []),
          { server: serverName, tool: toolName, arguments: sourceArgs() }] : [] };
      const trace = inspectCarryNativeTurn(evidence);
      expect(trace,
        JSON.stringify({ threadRead, terminal: events.find(frame => frame.method === 'turn/completed') }))
        .toEqual({ status: 'verified', violations: [], missing: [], finalResponse: expectedResponse,
          inputSha256: createHash('sha256').update(inputText).digest('hex'),
          mcpItemIds: platform ? [expect.any(String), expect.any(String)] : readSource ? [expect.any(String)] : [] });
      if (!readSource) {
        expect(JSON.stringify(providerCalls[0].input)).toContain(JSON.stringify(task.prompt).slice(1, -1));
        const responseProof = inspectCarryTaskResponse({ taskId: task.id, response: trace.finalResponse! });
        expect(responseProof).toEqual({ evidenceKind: 'response-only', matches: true,
          taskId: task.id, oracleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          missing: [], violations: [], recipeSha256: recipe.sha256 });
        expect(responseProof).not.toHaveProperty('quality');
      }
      // Use the captured native frame arrival, not the later thread/read or
      // polling completion time. Full action/history validation above must
      // pass before this terminal response can count as useful even locally.
      const useful = protocolReceipts.filter(r => r.phase === 'received' && r.frame.method === 'item/completed' &&
        (r.frame.params as RpcFrame).threadId === threadId && (r.frame.params as RpcFrame).turnId === turnId &&
        ((r.frame.params as RpcFrame).item as RpcFrame).type === 'agentMessage' &&
        ((r.frame.params as RpcFrame).item as RpcFrame).text === expectedResponse);
      expect(useful).toHaveLength(1);
      expect(useful[0].atMs).toBeGreaterThanOrEqual(rpcWrite.atMs);
      expect(completed.atMs).toBeGreaterThanOrEqual(useful[0].atMs);
      expect(new Set(protocolReceipts.map(r => r.clockId)).size).toBe(1);
      if (sourceCompleted) {
        expect(sourceCompleted.peerId).not.toBe(rpcWrite.peerId);
        expect(rpcWrite.atMs).toBeGreaterThanOrEqual(sourceCompleted.atMs);
      }
      // Do not pass rpcWrite as measureCarryArmTiming.firstRequestDispatched:
      // the native engine still owns the later provider send, unobserved here.
      if (readSource) {
        expect(observedReads).toEqual(platform ? [] : [readArgs]);
        if (platform) {
          const items = ((threadRead.thread as RpcFrame).turns as RpcFrame[])[0].items as RpcFrame[];
          const identity = items.filter(item => item.type === 'mcpToolCall' &&
            (item.arguments as RpcFrame).name === 'coord:whoami');
          expect(identity).toHaveLength(1);
          const receipts = ((identity[0].result as RpcFrame).content as Array<{ text?: string }>).flatMap(block => {
            try { const value = JSON.parse(block.text ?? ''); return value.ownerId ? [value] : []; } catch { return []; }
          });
          expect(receipts).toHaveLength(1);
          expect(receipts[0].ownerId).toBe(process.env.PAPERCUSP_SID);
          expect(receipts[0].workspaceId).toBe(process.env.PAPERCUSP_WORKSPACE);
        }
        const sourceRef = `codex:${predecessor!.threadId}/${predecessor!.turnId}@${predecessor!.snapshot.sha256}`;
        expect(inspectCarrySourceRead(evidence, { sourceRef,
          server: serverName, tool: toolName, filePath: predecessor!.filePath,
          byteOffset: readArgs.byte_offset, byteLength: window.length,
          totalBytes: predecessor!.snapshot.completeBytes, sha256: createHash('sha256').update(window).digest('hex') }))
          .toMatchObject({ status: 'verified', missing: [], violations: [], sourceRef });
        await recheckCarrySourceSnapshot(predecessor!);
        expect(threadId).not.toBe(predecessor!.threadId);
      }
      expect(httpErrors).toEqual([]);
      expect(requests).toBe(platform ? 3 : readSource ? 2 : 1);
      expect(preparationRequests).toBe(readSource ? 1 : 0);
      const source = await captureCompletedCarrySource(p!, threadId, turnId);
      expect(source.filePath).toBe((threadRead.thread as RpcFrame).path);
      expect(source.snapshot.completeBytes).toBeGreaterThan(0);
      expect(source.snapshot.highWaterBytes).toBe(source.snapshot.completeBytes);
      await expect(recheckCarrySourceSnapshot(source)).resolves.toBeUndefined();
      if (platform) console.info('CARRY_NATIVE_PLATFORM_SOURCE_RECEIPT', JSON.stringify({ threadId, turnId,
        predecessorThread: predecessor!.threadId, predecessorTurn: predecessor!.turnId,
        predecessorSha256: predecessor!.snapshot.sha256, successorSha256: source.snapshot.sha256,
        windowSha256: createHash('sha256').update(window).digest('hex'),
        ownerId: process.env.PAPERCUSP_SID, workspaceId: process.env.PAPERCUSP_WORKSPACE,
        scriptedRequests: preparationRequests + requests, providerInference: false }));
    } finally {
      try { if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); } }
      finally {
        await Promise.all(mcpHosts.map(host => host.close()));
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);
  }

  it.each(['ok', 'preparation-drift', 'source-writer-busy', 'source-guard-conflict', 'source-guard-exited', 'source-lock-replaced',
    'ancestor', 'ancestor-writer-busy', 'ancestor-guard-conflict', 'source-acquisition-race', 'source-read', 'model-switch',
    'rejected-alternative', 'authority-boundary', 'home-reset', 'home-reset-candidate-first',
    'home-reset-source-read', 'home-reset-source-read-candidate-first',
    'home-reset-rejected-alternative', 'home-reset-rejected-alternative-candidate-first',
    'home-reset-authority-boundary', 'home-reset-authority-boundary-candidate-first',
    'home-reset-model-switch', 'home-reset-model-switch-candidate-first',
    'home-reset-ancestor', 'home-reset-ancestor-candidate-first', 'foreign-source-home'] as const)(
    'composes an unpaid frozen-source control and managed-carry candidate across native processes (%s)', async mode => {
    const { createInferenceGateway } = await import('./inference-gateway/gateway');
    const { createFailoverPool } = await import('./inference-gateway/account-failover');
    const { resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');
    const { mintCarryRespawnArgs, codexThreadWriterLockPath, codexThreadWriterHolder,
      codexThreadWriterStatErrorCode } = await vi.importActual<{
      codexThreadWriterLockPath: (home: string, threadId: string) => string;
      codexThreadWriterHolder: (home: string, threadId: string) => {
        held: boolean; pid: number | null; reason: string; statErrorCodes?: string[];
      };
      codexThreadWriterStatErrorCode: (error: unknown) => string;
      mintCarryRespawnArgs: (args: string[], options: Record<string, unknown>) => {
      args: string[]; carryText: string; launchContextPath: string; codexAgentsPath: string; predecessorSessionId: string;
    } }>('../../../apps/operator/scripts/psu-launcher.mjs');
    resetGovernorRegistry();
    const readSource = mode.includes('source-read');
    const switchModel = mode.includes('model-switch');
    const resetHome = mode.startsWith('home-reset');
    const homeExperiment = resetHome || mode === 'foreign-source-home';
    const armOrder: Array<'control' | 'candidate'> = mode.endsWith('candidate-first')
      ? ['candidate', 'control'] : ['control', 'candidate'];
    const taskId = readSource ? 'T2' : mode.includes('rejected-alternative') ? 'T3'
      : mode.includes('authority-boundary') ? 'T4' : switchModel ? 'T5' : 'T1';
    const recipe = createCarryTrialRecipe(), task = recipe.tasks.find(task => task.id === taskId)!;
    const ancestorDepth = mode.includes('ancestor') ? 2 : 0;
    const owner = 'su-unpaid-carry-pair';
    const nativeHome = mkdtempSync(join(tmpdir(), 'unpaid-carry-pair-')); homes.push(nativeHome);
    const nativeHomes = [nativeHome];
    const basePath = join(nativeHome, 'AGENTS.md');
    const base = '# Unpaid synthetic fixture\nThe seed grants no platform authority.\n';
    writeFileSync(basePath, base);
    const recipePath = join(nativeHome, 'frozen-recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));
    let phase: 'preparation' | 'control' | 'carry' | 'candidate' = 'preparation';
    const requests: Array<{ phase: string; body: Record<string, unknown> }> = [];
    const failures: string[] = [];
    const mcpHosts: McpServer[] = [];
    const observedReads: Array<{ phase: string; args: unknown }> = [];
    const modelWitnesses: Array<{ phase: string; threadId: string; turnId: string; model: string; requests: number }> = [];
    let sourceWindow: Parameters<typeof inspectCarrySourceRead>[1] | undefined;
    let readArgs: { file_path: string; byte_offset: number; byte_limit: number } | undefined;
    const upstream = createServer(async (req, res) => {
      try {
        if (req.url === '/mcp') {
          expect(req.headers.authorization).toBe('Bearer offline-fixture');
          const host = new McpServer({ name: 'carry-pair-source-fixture', version: '1' }); mcpHosts.push(host);
          host.registerTool('capability_read', {
            inputSchema: { file_path: z.string(), byte_offset: z.number(), byte_limit: z.number() },
            annotations: { readOnlyHint: true },
          }, async args => {
            observedReads.push({ phase, args });
            return await sourceReadTool.handler(args as never, { projectDir: nativeHome } as never) as {
              content: Array<{ type: 'text'; text: string }>;
            };
          });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await host.connect(transport); await transport.handleRequest(req, res); return;
        }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({ phase, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        if (readSource && (phase === 'control' || phase === 'candidate') &&
          requests.filter(request => request.phase === phase).length === 1) {
          const item = { id: `fc_${phase}`, type: 'function_call', call_id: `source-${phase}`,
            namespace: 'mcp__cache_receipts', name: 'capability_read', arguments: JSON.stringify(readArgs), status: 'completed' };
          const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 1200, outputTokens: 40 }), output: [item] };
          const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
            event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
          return;
        }
        const response = phase === 'preparation' ? recipe.sourcePreparation.expectedAcknowledgement
          : phase === 'carry' ? { carryReceived: true } : readSource ? { ...task.expected, sourceRef: sourceWindow!.sourceRef } : task.expected;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: String(requests.at(-1)!.body.model),
          text: JSON.stringify(response), inputTokens: 1200, outputTokens: 40 })));
      } catch { failures.push('unpaid fixture request failed'); res.destroy(); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    const gateway = createInferenceGateway({ accountId: 'fixture', token: async () => 'PRIVATE_UNPAID',
      upstreamBase: `http://127.0.0.1:${address.port}`, openaiUpstreamBase: `http://127.0.0.1:${address.port}`,
      codexPool: createFailoverPool([{ accountId: 'fixture', token: async () => 'PRIVATE_UNPAID' }]),
      concurrency: 1, maxQueueWaitMs: 2000, requestAbsorbMs: 0, selfHeal: { enabled: false } });
    const captures: Parameters<typeof inspectCarryNativePopulation>[0][] = [];
    const armTimings: Array<{ arm: string; preflightAgeMs: number; firstDispatchRef: string;
      measurement: ReturnType<typeof measureCarryArmTiming> }> = [];
    const manifests: Awaited<ReturnType<typeof captureCarryArtifactManifest>>[] = [];
    const controllers = new Map<Awaited<ReturnType<typeof captureCarryArtifactManifest>>, ReturnType<typeof controllerLoaderProbe>>();
    const runtimeBoundaries: Array<{ threadId: string; turnId?: string; phase: string;
      runtime: Awaited<ReturnType<typeof captureCarryRuntimeSnapshot>> }> = [];
    const sourceGuards: Array<{ peer: SuStdioPeer; threadId: string; path: string; device: bigint; inode: bigint }> = [];
    const sourceGuardObservations: Array<Record<string, unknown>> = [];
    let source: CarrySourceSnapshot | undefined;
    try {
      const assertSourceGuards = () => {
        for (const guard of sourceGuards) {
          let fileStatErrorCode: string | null = null;
          const file = (() => {
            try { return lstatSync(guard.path, { bigint: true }); }
            catch (error) {
              fileStatErrorCode = codexThreadWriterStatErrorCode(error);
              return null;
            }
          })();
          const holder = codexThreadWriterHolder(nativeHome, guard.threadId);
          const peerState = guard.peer.receiptState?.();
          const peerPid = guard.peer.pid();
          const missing = [
            !file?.isFile() && (fileStatErrorCode && fileStatErrorCode !== 'ENOENT'
              ? 'lock-file-stat-error-' + fileStatErrorCode : 'lock-file-missing'),
            file && (file.dev !== guard.device || file.ino !== guard.inode) && 'lock-inode-changed',
            peerState?.exited !== false && 'guard-peer-exited',
            !holder.held && `flock-${holder.reason}`,
            holder.held && holder.pid !== peerPid && 'flock-holder-mismatch',
          ].filter(Boolean);
          const observation = {
            at: new Date().toISOString(), phase, threadId: guard.threadId, path: guard.path,
            expectedDevice: guard.device.toString(), expectedInode: guard.inode.toString(),
            fileIsFile: file?.isFile() ?? false, actualDevice: file?.dev.toString() ?? null,
            actualInode: file?.ino.toString() ?? null, fileStatErrorCode,
            peerPid, peerExited: peerState?.exited ?? null,
            holderHeld: holder.held, holderPid: holder.pid, holderReason: holder.reason,
            holderStatErrorCodes: holder.statErrorCodes ?? [],
          };
          sourceGuardObservations.push(observation);
          if (missing.length) throw new Error(`frozen source native writer guard lost (${missing.join(',')}; probe=${JSON.stringify(observation)})`);
        }
      };
      const port = await gateway.listen(0);
      const config = stringifyToml({ model_provider: 'cache_protocol_probe', model_reasoning_effort: 'medium',
        model_providers: { cache_protocol_probe: { name: 'Unpaid loopback', base_url: `http://127.0.0.1:${port}/v1`,
          wire_api: 'responses', requires_openai_auth: false, http_headers: { 'x-papercusp-owner': owner },
          supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false, shell_snapshot: false, plugins: false, remote_plugin: false },
        web_search: 'disabled',
        ...(readSource ? { mcp_servers: { cache_receipts: { url: `http://127.0.0.1:${address.port}/mcp`,
          http_headers: { Authorization: 'Bearer offline-fixture' } } } } : {}),
      } as Parameters<typeof stringifyToml>[0]);
      const openNative = async (home = nativeHome) => {
        const events: RpcFrame[] = [], receipts: SuStdioReceipt[] = [];
        const loader = nodeLoaderProbe(home, `peer-${manifests.length}`);
        const p = await peer('codex', ['app-server'], loader.env, frame => events.push(frame), config,
          receipt => receipts.push(receipt), home);
        await p.request({ method: 'initialize', params: { clientInfo: { name: 'unpaid_carry_pair', version: '1' } } });
        const runtime = await captureCarryRuntimeSnapshot(p.pid()!);
        await recheckCarryRuntimeSnapshot(runtime);
        p.send({ method: 'initialized', params: {} });
        return { p, events, receipts, runtime, home, loader };
      };
      const captureManifest = async (live: Awaited<ReturnType<typeof openNative>>, threadId: string,
        extra: { artifacts: CarryArtifactInput[]; roots: CarryDependencyScope['roots'] } = { artifacts: [], roots: [] }) => {
        if (readSource) await waitForMcpStartup(live.events, threadId, 'cache_receipts');
        const configuration = await captureCarryNativeConfiguration(live.p, { threadId, cwd: nativeHome,
          servers: readSource ? [{ name: 'cache_receipts', tools: ['capability_read'], authStatus: 'bearerToken' }] : [] });
        // Capture after thread/config startup as well: databases and rollouts
        // can open after initialize. Preserve mutable observations as evidence,
        // without pretending their live bytes are immutable dependencies.
        const runtime = await captureCarryRuntimeSnapshot(live.p.pid()!);
        runtimeBoundaries.push({ threadId, phase: 'before-first-turn', runtime });
        const mutablePaths = [...new Set([...runtime.writableSharedFiles, ...runtime.writableOpenFiles])].sort();
        const frozenRuntime = runtime.artifacts.filter(a => !mutablePaths.includes(a.filePath));
        const runtimePath = join(nativeHome, `runtime-${manifests.length}.json`);
        writeFileSync(runtimePath, JSON.stringify(runtime));
        // Bind the actual owned wrapper script, not just the Node executable
        // from /proc/exe. A different wrapper shape needs its own observation.
        const argv = readFileSync(`/proc/${live.p.pid()}/cmdline`, 'utf8').split('\0').filter(Boolean);
        expect(argv.slice(2)).toEqual(['app-server']);
        expect(isAbsolute(argv[1])).toBe(true);
        const loaderRows = live.loader.read(live.p.pid()!);
        expect(loaderRows.some(row => row.phase === 'load' && row.filePath === realpathSync(argv[1]))).toBe(true);
        const loaderFiles = [...new Set(loaderRows.flatMap(row => row.filePath ? [row.filePath] : []))].sort();
        const artifacts: CarryArtifactInput[] = [
          ...frozenRuntime,
          { id: 'runtime-observation', filePath: runtimePath, maxBytes: 1024 * 1024 },
          { id: 'wrapper-script', filePath: argv[1], maxBytes: 1024 * 1024 },
          { id: 'source-writer-flock', filePath: '/usr/bin/flock', maxBytes: 1024 * 1024 },
          { id: 'source-writer-node', filePath: process.execPath, maxBytes: 512 * 1024 * 1024 },
          { id: 'base', filePath: basePath, maxBytes: 1024 * 1024 },
          { id: 'recipe-data', filePath: recipePath, maxBytes: 1024 * 1024 },
          ...[
            ['driver', './su-session-stdio-peer.integration.test.ts'], ['transport', './su-session-stdio-peer.ts'],
            ['scanner', './launch-cost/scan-launch-transcripts.ts'], ['recipe-checker', './launch-cost/launch-cost-metrics.ts'],
            ['launcher', '../../../apps/operator/scripts/psu-launcher.mjs'],
            ['usage-parser', './interactive-usage/ingest-adapters.ts'], ['usage-writer', './interactive-usage/ingest-claude-transcripts.ts'],
            ['gateway', './inference-gateway/gateway.ts'], ['gateway-observer', './inference-gateway/request-stage-telemetry.ts'],
            ['clock', './process-monotonic-clock.ts'],
            ['import-extractor', '../../../scripts/check-transitive-boundary.mjs'],
            ...(readSource ? [['source-read-tool', './agent-tools/capability/read.ts']] : []),
          ].map(([id, path]) => ({ id, filePath: fileURLToPath(new URL(path, import.meta.url)), maxBytes: 1024 * 1024 })),
          { id: 'pricing', filePath: fileURLToPath(import.meta.resolve('@papercusp/model-pricing')), maxBytes: 1024 * 1024 },
          { id: 'pricing-package', filePath: fileURLToPath(import.meta.resolve('@papercusp/model-pricing/package.json')), maxBytes: 1024 * 1024 },
          { id: 'typescript-parser', filePath: fileURLToPath(import.meta.resolve('typescript')), maxBytes: 32 * 1024 * 1024 },
          { id: 'loader-hook', filePath: live.loader.hookPath, maxBytes: 1024 * 1024 },
          { id: 'loader-observation', filePath: live.loader.tracePath, maxBytes: 1024 * 1024 },
          ...extra.artifacts,
        ];
        for (const path of loaderFiles) {
          if (!artifacts.some(artifact => realpathSync(artifact.filePath) === realpathSync(path))) {
            artifacts.push({ id: `node-loader-${artifacts.length}`, filePath: path, maxBytes: 4 * 1024 * 1024 });
          }
        }
        for (const [id, specifier] of [['controller-vite-package', 'vite/package.json'],
          ['controller-vitest-package', 'vitest/package.json'], ['controller-vite-runner', 'vite/module-runner']]) {
          artifacts.push({ id, filePath: fileURLToPath(import.meta.resolve(specifier)), maxBytes: 4 * 1024 * 1024 });
        }
        const capture = () => captureCarryArtifactManifest({ protocolRef: `D017:unpaid-local-${task.id}-pair`, configuration, artifacts,
          relativeScriptRoots: ['scanner', 'launcher', 'usage-parser', 'recipe-checker', 'wrapper-script', 'import-extractor'],
          scriptArtifactIds: ['driver', 'transport', 'scanner', 'recipe-checker', 'launcher', 'usage-parser',
            'usage-writer', 'gateway', 'gateway-observer', 'clock', 'wrapper-script', 'pricing', 'import-extractor', 'loader-hook',
            ...(readSource ? ['source-read-tool'] : [])],
          dependencyScope: { recipeSha256: recipe.sha256,
            roots: [{ role: 'instrument', artifactIds: ['driver'] }, { role: 'launcher', artifactIds: ['launcher'] },
              { role: 'native-runtime', artifactIds: frozenRuntime.map(a => a.id) },
              { role: 'scripts', artifactIds: ['wrapper-script', 'source-writer-flock', 'source-writer-node'] },
              { role: 'task', artifactIds: ['recipe-data'] }, { role: 'seed', artifactIds: ['recipe-data'] },
              { role: 'pricing', artifactIds: ['pricing', 'pricing-package'] }, { role: 'checker', artifactIds: ['recipe-checker'] },
              ...extra.roots],
            nodes: artifacts.map(a => ({ artifactId: a.id, dependsOn: a.id === 'driver' ? artifacts.filter(b => b.id !== a.id).map(b => b.id) : [] })),
            unresolved: [...mutablePaths.map(path => `unfrozen writable native file: ${path}`),
              'wrapper Node events and retained Vitest controller cache only; external/mocked/pre-observer/evicted modules, production transforms, Rust data reads, unexercised branches and transient/default native storage remain uncensused',
              'fixture disables optional shell/plugin work; transient native storage and external writers remain unproven',
              'scripted app-server delivery is not production host adoption, model quality, native output bounds or authenticated charges'] } });
        // The existing census lazily loads its AST parser/extractor. Observe the
        // controller AFTER that work so the very first preparation manifest also
        // binds their retained transforms. Both captures are timed preparation;
        // no inference request is dispatched between them.
        await capture();
        const controller = controllerLoaderProbe(live.home, `controller-${manifests.length}`, artifacts.filter(a =>
          ['driver', 'transport', 'scanner', 'recipe-checker', 'launcher', 'usage-parser', 'usage-writer', 'gateway',
            'gateway-observer', 'clock', 'pricing', 'import-extractor', 'source-read-tool'].includes(a.id)));
        artifacts.push(...controller.artifacts);
        const manifest = await capture();
        manifests.push(manifest);
        controllers.set(manifest, controller);
        controller.recheck();
        for (const row of controller.observation.selectedRows.filter(row => row.kind === 'transformed')) {
          expect(manifest.artifacts.find(a => a.id === `controller-transform-${row.idSha256}`)?.sha256).toBe(row.transformedSha256);
        }
        for (const id of ['driver', 'transport', 'scanner', 'recipe-checker', 'import-extractor']) {
          const path = realpathSync(artifacts.find(a => a.id === id)!.filePath);
          expect(controller.observation.selectedRows.some(row => row.filePath === path && row.kind === 'transformed')).toBe(true);
        }
        for (const row of loaderRows.filter(row => row.phase === 'load' && row.filePath && row.sourceSha256)) {
          expect(manifest.artifacts.find(artifact => artifact.resolvedPath === realpathSync(row.filePath!))?.sha256)
            .toBe(row.sourceSha256);
        }
        expect(manifest.scriptCensus).toMatchObject({ runtimeClosureEstablished: false });
        expect(manifest.scriptCensus!.relativeTraversal!.artifacts.length).toBeGreaterThan(0);
        expect(manifest.scriptCensus!.relativeTraversal!.scannedArtifactIds).toContain('recipe-checker');
        expect(manifest.scriptCensus!.sites.some(site => site.disposition === 'unbound-relative')).toBe(true);
        expect(manifest.scriptCensus!.sites.some(site => site.disposition === 'external-module')).toBe(true);
        expect(manifest.dependencyScope!.unresolved).toEqual(expect.arrayContaining(
          mutablePaths.map(path => `unfrozen writable native file: ${path}`)));
        expect(runtime.writableOpenFiles.some(path => /\.sqlite(?:-wal)?$/.test(path))).toBe(true);
        expect(JSON.parse(readFileSync(runtimePath, 'utf8'))).toEqual(runtime);
        console.log('CARRY_NODE_LOADER_RECEIPT', JSON.stringify({ threadId,
          rootPid: live.p.pid(), records: loaderRows.length, phases: [...new Set(loaderRows.map(row => row.phase))].sort(),
          conditions: [...new Set(loaderRows.flatMap(row => row.conditions ?? []))].sort(),
          sourceBoundLoads: loaderRows.filter(row => row.phase === 'load' && row.filePath && row.sourceSha256).length,
          sourceUnavailableLoads: loaderRows.filter(row => row.phase === 'load' && row.filePath && !row.sourceSha256).length,
          fileArtifacts: loaderFiles.map(path => ({ filePath: path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
          traceSha256: createHash('sha256').update(readFileSync(live.loader.tracePath)).digest('hex'),
          runtimeClosureEstablished: false }));
        console.log('CARRY_CONTROLLER_LOADER_RECEIPT', JSON.stringify({ threadId, pid: process.pid,
          cacheEntries: controller.observation.rows.length,
          selected: controller.observation.selectedRows.map(row => ({ filePath: row.filePath, kind: row.kind,
            evaluationSettled: row.evaluationSettled, transformedSha256: row.transformedSha256 })),
          unmatchedPaths: controller.observation.unmatchedPaths,
          artifactHashes: manifest.artifacts.filter(a => a.id.startsWith('controller-')).map(a => ({ id: a.id, sha256: a.sha256 })),
          runtimeClosureEstablished: false }));
        return manifest;
      };
      const turn = async (live: Awaited<ReturnType<typeof openNative>>, threadId: string, text: string,
        manifest: Awaited<ReturnType<typeof captureManifest>>) => {
        await recheckCarryArtifactManifest(manifest, live.p);
        controllers.get(manifest)!.recheck();
        assertSourceGuards();
        if (source) await recheckCarrySourceSnapshot(source);
        const eventStart = live.events.length;
        const requestStart = requests.length;
        const model = switchModel && (phase === 'control' || phase === 'candidate') ? 'gpt-6-luna' : 'gpt-6-sol';
        const response = await live.p.request({ method: 'turn/start', params: { threadId, input: [{ type: 'text', text }],
          ...(switchModel ? { model } : {}) } });
        const turnId = String((response.turn as RpcFrame).id);
        const terminal = () => live.events.find(event => event.method === 'turn/completed' &&
          (event.params as RpcFrame).threadId === threadId && ((event.params as RpcFrame).turn as RpcFrame).id === turnId);
        await vi.waitFor(() => expect(terminal() !== undefined).toBe(true), { timeout: 20_000 });
        expect(((terminal()!.params as RpcFrame).turn as RpcFrame).status, `unpaid native phase ${phase}`).toBe('completed');
        const threadRead = await live.p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
        const evidence = { threadId, turnId, events: live.events.slice(eventStart), threadRead,
          allowedMcpCalls: readSource && (phase === 'control' || phase === 'candidate')
            ? [{ server: 'cache_receipts', tool: 'capability_read', arguments: readArgs }] : [], expectedInputText: text };
        const trace = inspectCarryNativeTurn(evidence);
        expect(trace.status).toBe('verified');
        const turnRequests = requests.slice(requestStart);
        expect(turnRequests.length).toBeGreaterThan(0);
        for (const request of turnRequests) {
          expect(request.body).toMatchObject({ model, reasoning: { effort: 'medium' } });
          const metadata = JSON.parse((request.body.client_metadata as Record<string, string>)['x-codex-turn-metadata']);
          expect(metadata).toMatchObject({ thread_id: threadId, turn_id: turnId });
        }
        modelWitnesses.push({ phase, threadId, turnId, model, requests: turnRequests.length });
        await recheckCarryArtifactManifest(manifest, live.p);
        controllers.get(manifest)!.recheck();
        assertSourceGuards();
        const runtimeAfter = await captureCarryRuntimeSnapshot(live.p.pid()!);
        runtimeBoundaries.push({ threadId, turnId, phase, runtime: runtimeAfter });
        return { turnId, threadRead, trace, runtimeAfter, evidence };
      };
      const options = { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe', cwd: nativeHome,
        approvalPolicy: 'never', sandbox: 'read-only' };
      const preparationStartedAt = processMonotonicClock.now();
      const preparation = await openNative();
      const started = await preparation.p.request({ method: 'thread/start', params: options });
      let sourceId = String((started.thread as RpcFrame).id);
      const preparationArms = [{ threadId: sourceId, armId: 'preparation' }];
      const preparationManifests: Awaited<ReturnType<typeof captureManifest>>[] = [];
      // Preparation is part of the population: bind its inputs before its first
      // request, not retroactively after the generated source is visible.
      const preparationManifest = await captureManifest(preparation, sourceId);
      preparationManifests.push(preparationManifest);
      expect(preparationManifest.dependencyScope!.missingRoles).toEqual(['source']);
      if (mode === 'preparation-drift') {
        writeFileSync(recipePath, JSON.stringify({ altered: true }));
        await expect(turn(preparation, sourceId, recipe.sourcePreparation.prompt, preparationManifest))
          .rejects.toThrow('carry artifacts changed after manifest freeze (recipe-data)');
        expect(requests).toEqual([]);
        expect(preparation.receipts.some(r => r.phase === 'write-started' && r.frame.method === 'turn/start')).toBe(false);
        // This stopped run is not retried with a refreshed manifest.
        return;
      }
      const preparationManifestPath = join(nativeHome, 'preparation-manifest.json');
      writeFileSync(preparationManifestPath, JSON.stringify(preparationManifest));
      let prepared = await turn(preparation, sourceId, recipe.sourcePreparation.prompt, preparationManifest);
      expect(inspectCarryPreparationResponse(prepared.trace.finalResponse!).matches).toBe(true);
      for (let depth = 0; depth < ancestorDepth; depth++) {
        preparationArms.at(-1)!.armId = `preparation-ancestor-${depth}`;
        const fork = await preparation.p.request({ method: 'thread/fork', params: { ...options, threadId: sourceId } });
        const forkId = String((fork.thread as RpcFrame).id);
        expect(forkId).not.toBe(sourceId);
        sourceId = forkId;
        preparationArms.push({ threadId: sourceId, armId: 'preparation' });
        const manifest = await captureManifest(preparation, sourceId);
        preparationManifests.push(manifest);
        prepared = await turn(preparation, sourceId, recipe.sourcePreparation.prompt, manifest);
        expect(inspectCarryPreparationResponse(prepared.trace.finalResponse!).matches).toBe(true);
      }
      source = await captureCompletedCarrySource(preparation.p, sourceId, prepared.turnId);
      expect(source.ancestors).toHaveLength(ancestorDepth);
      // Read the installed native rollout and its actual completion receipt.
      // The loopback provider scripts 1,200 input tokens, below both registered
      // history bands; never turn fixture byte size into a qualified cohort.
      const sourcePreflight = await captureCarrySourcePreflight({ source, sourceId: 'S-I0', receipts: preparation.receipts });
      expect(sourcePreflight).toMatchObject({ dispatchAuthorized: false, missing: [],
        history: { inputTokens: 1200, inBand: false }, idle: { clockId: processMonotonicClock.id } });
      expect(sourcePreflight.idle!.ageMs).toBeGreaterThanOrEqual(0);
      console.info('CARRY_SOURCE_PREFLIGHT_RECEIPT', JSON.stringify(sourcePreflight));
      // A stopped wrapper alone is insufficient evidence of a closed native
      // storage writer. Check every process observed in this preparation peer.
      if (homeExperiment) await vi.waitFor(() => {
        for (const process of preparation.runtime.processes) expect(existsSync(`/proc/${process.pid}`)).toBe(false);
      }, { timeout: 5000 });
      const sourceWindowPath = join(nativeHome, 'source-window.json');
      if (readSource) {
        const window = Buffer.from(String(task.expected.sourceSentinel));
        const byteOffset = source.snapshot.bytes.indexOf(window);
        expect(byteOffset).toBeGreaterThan(0);
        readArgs = { file_path: source.filePath, byte_offset: byteOffset, byte_limit: window.length };
        sourceWindow = { sourceRef: `codex:${source.threadId}/${source.turnId}@${source.snapshot.sha256}`,
          server: 'cache_receipts', tool: 'capability_read', filePath: source.filePath,
          byteOffset, byteLength: window.length, totalBytes: source.snapshot.completeBytes,
          sha256: createHash('sha256').update(window).digest('hex') };
        writeFileSync(sourceWindowPath, JSON.stringify(sourceWindow));
      }
      captures.push({ receipts: preparation.receipts, state: preparation.p.receiptState?.(),
        arms: preparationArms });
      expect(inspectCarryNativePopulation(captures[0]).status).toBe('closed-peer-reconciled');
      const preparationCloseoutPath = join(nativeHome, 'preparation-closeout.json');
      const sourceFiles = [source, ...source.ancestors];
      const orderedSources = [...sourceFiles].sort((a, b) => a.threadId.localeCompare(b.threadId));
      const preparationPhases = preparationArms.map(() => 'preparation');
      // Reuse the launcher's native lock identity, never infer exclusion from
      // thread/read or unchanged hashes. These advisory locks exclude Codex
      // writers that honor the native protocol, not arbitrary filesystem edits.
      const acquireSourceGuard = async (member: typeof sourceFiles[number]) => {
        const path = codexThreadWriterLockPath(nativeHome, member.threadId);
        // Native teardown removes its lock file. flock creates a fresh lock
        // inode in this owned test home; bind the inode AFTER acquisition.
        const guard = await peer('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', path, process.execPath, '-e', `
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            process.stdout.write(JSON.stringify({ id: request.id, result: { locked: true } }) + '\\n');
          });
        `], {}, undefined, undefined, () => {});
        try {
          expect(await guard.request({ method: 'ready' }, 5000)).toEqual({ locked: true });
          const file = lstatSync(path, { bigint: true });
          expect(file.isFile()).toBe(true);
          sourceGuards.push({ peer: guard, threadId: member.threadId, path, device: file.dev, inode: file.ino });
        } catch (error) {
          await guard.close();
          await guard.done.catch(() => undefined); // Original failure is rethrown below.
          throw error;
        }
      };
      if (mode === 'source-acquisition-race') {
        const competitor = await openNative();
        const outcomes = await Promise.allSettled([
          acquireSourceGuard(source),
          competitor.p.request({ method: 'thread/resume', params: { ...options, threadId: sourceId } }),
        ]);
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        if (outcomes[0].status === 'fulfilled') {
          expect(String((outcomes[1] as PromiseRejectedResult).reason)).toMatch(/active writer/);
          assertSourceGuards(); await recheckCarrySourceSnapshot(source);
        } else {
          expect(String(outcomes[0].reason)).toMatch(/exited|closed|EPIPE/);
          const holder = codexThreadWriterHolder(nativeHome, sourceId);
          expect(holder.held).toBe(true);
          expect(competitor.runtime.processes.some(process => process.pid === holder.pid)).toBe(true);
        }
        expect(requests.map(request => request.phase)).toEqual(preparationPhases);
        console.log('CARRY_SOURCE_ACQUISITION_RACE', JSON.stringify({
          winner: outcomes[0].status === 'fulfilled' ? 'fixture-guard' : 'native-resume', armDispatches: 0,
          sourceRefreshed: false, scope: 'one-observed-native-race' }));
        await competitor.p.close(); await competitor.p.done;
        return;
      }
      let competingWriter: Awaited<ReturnType<typeof openNative>> | undefined;
      const busySource = mode === 'source-writer-busy' || mode === 'ancestor-writer-busy' ? orderedSources.at(-1) : undefined;
      if (busySource) {
        competingWriter = await openNative();
        await competingWriter.p.request({ method: 'thread/resume', params: { ...options, threadId: busySource.threadId } });
      }
      for (const member of orderedSources) {
        if (member === busySource) {
          await expect(acquireSourceGuard(member)).rejects.toThrow(/exited|closed|EPIPE/);
          expect(codexThreadWriterHolder(nativeHome, member.threadId).held).toBe(true);
          expect(sourceGuards).toHaveLength(ancestorDepth);
          // Acquisition is all-or-nothing for dispatch: release previously
          // acquired ancestors on failure, without touching the busy writer.
          for (const guard of sourceGuards) { await guard.peer.close(); await guard.peer.done; }
          for (const guard of sourceGuards) expect(codexThreadWriterHolder(nativeHome, guard.threadId).held).toBe(false);
          sourceGuards.length = 0;
          expect(requests.map(request => request.phase)).toEqual(preparationPhases);
          await competingWriter!.p.close(); await competingWriter!.p.done;
          return;
        }
        await acquireSourceGuard(member);
      }
      assertSourceGuards();
      // Acquiring a lock cannot repair a source that changed in the interval
      // after its producing peer closed. Recheck the original cut unchanged.
      await recheckCarrySourceSnapshot(source);
      if (mode === 'source-guard-conflict' || mode === 'ancestor-guard-conflict') {
        const competitor = await openNative();
        for (const member of orderedSources) {
          await expect(competitor.p.request({ method: 'thread/resume', params: { ...options, threadId: member.threadId } }))
            .rejects.toThrow(/active writer/);
        }
        assertSourceGuards();
        await recheckCarrySourceSnapshot(source);
        expect(requests.map(request => request.phase)).toEqual(preparationPhases);
        await competitor.p.close(); await competitor.p.done;
        for (const guard of sourceGuards) { await guard.peer.close(); await guard.peer.done; }
        sourceGuards.length = 0;
        const afterRelease = await openNative();
        expect((await afterRelease.p.request({ method: 'thread/resume', params: { ...options, threadId: sourceId } })).thread)
          .toMatchObject({ id: sourceId });
        await afterRelease.p.close(); await afterRelease.p.done;
        return;
      }
      if (mode === 'source-guard-exited' || mode === 'source-lock-replaced') {
        const candidate = await openNative();
        const opened = await candidate.p.request({ method: 'thread/start', params: options });
        const threadId = String((opened.thread as RpcFrame).id);
        const manifest = await captureManifest(candidate, threadId);
        if (mode === 'source-guard-exited') {
          await sourceGuards[0].peer.close(); await sourceGuards[0].peer.done;
        } else {
          // Only the owned disposable fixture lock is replaced. Never do this
          // to a production/native peer lock to bypass its writer exclusion.
          rmSync(sourceGuards[0].path); writeFileSync(sourceGuards[0].path, '');
        }
        await expect(turn(candidate, threadId, task.prompt, manifest)).rejects.toThrow('frozen source native writer guard lost');
        expect(candidate.receipts.some(receipt => receipt.phase === 'write-started' && receipt.frame.method === 'turn/start')).toBe(false);
        expect(requests.map(request => request.phase)).toEqual(['preparation']);
        await candidate.p.close(); await candidate.p.done;
        return;
      }
      const preparationCloseout = { evidenceKind: 'observation-only', manifestSha256: preparationManifest.sha256,
        recipeSha256: recipe.sha256, inputSha256: prepared.trace.inputSha256,
        nativeCaptureSha256: createHash('sha256').update(JSON.stringify(captures[0])).digest('hex'),
        runtimeAfter: prepared.runtimeAfter,
        preparationManifests,
        sourceWriterGuards: sourceGuards.map(guard => ({ threadId: guard.threadId, path: guard.path,
          device: guard.device.toString(), inode: guard.inode.toString(), pid: guard.peer.pid() })),
        source: sourceFiles.map(s => ({ threadId: s.threadId, turnId: s.turnId, filePath: s.filePath,
          sha256: s.snapshot.sha256, bytes: s.snapshot.highWaterBytes, forkedFromId: s.forkedFromId })),
        admission: 'not-established', accountingComplete: false };
      writeFileSync(preparationCloseoutPath, JSON.stringify(preparationCloseout));
      // Mint from the exact stopped source BEFORE the control creates a newer
      // rollout. Both arms see the same base pointer; only candidate receives
      // the managed carry turn. This is explicit app-server delivery, not host
      // adoption or a measurement of natural first-two startup phases.
      const carry = mintCarryRespawnArgs(['fork', sourceId], { agent: 'codex', home: nativeHome,
        codexHome: nativeHome, ownerId: owner, systemPromptAddendum: recipe.seedText });
      expect(carry.predecessorSessionId).toBe(sourceId);
      expect(carry.args).toEqual([]);
      expect(readFileSync(basePath, 'utf8')).not.toContain(recipe.seedText);
      expect(readFileSync(carry.launchContextPath, 'utf8')).toContain(recipe.seedText);
      const excluded = new Set([...sourceFiles.map(member => relative(nativeHome, member.filePath)),
        ...sourceGuards.map(guard => relative(nativeHome, guard.path))]);
      const sourceInodes = () => sourceFiles.map(member => {
        const stat = lstatSync(member.filePath, { bigint: true });
        return { path: member.filePath, device: stat.dev.toString(), inode: stat.ino.toString() };
      });
      const frozenSourceInodes = sourceInodes();
      const homeSnapshot = (home: string) => {
        const entries: Array<{ path: string; kind: string; mode: number; size?: number; sha256?: string; target?: string }> = [];
        let bytes = 0;
        const walk = (directory: string) => {
          for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(directory, entry.name), name = relative(home, path);
            if (excluded.has(name)) continue;
            const stat = lstatSync(path);
            if (entries.length >= 1024) throw new Error('fixture home inventory exceeds file bound');
            if (stat.isSymbolicLink()) entries.push({ path: name, kind: 'symlink', mode: stat.mode, target: readlinkSync(path) });
            else if (stat.isDirectory()) { entries.push({ path: name, kind: 'directory', mode: stat.mode }); walk(path); }
            else if (stat.isFile()) {
              bytes += stat.size;
              if (bytes > 64 * 1024 * 1024) throw new Error('fixture home inventory exceeds byte bound');
              entries.push({ path: name, kind: 'file', mode: stat.mode, size: stat.size,
                sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
            } else throw new Error(`unsupported closed fixture home entry: ${name}`);
          }
        };
        walk(home); return entries;
      };
      const initialHome = homeExperiment ? homeSnapshot(nativeHome) : [];
      const resetArtifacts = homeExperiment ? mkdtempSync(join(tmpdir(), 'unpaid-carry-home-reset-')) : '';
      if (homeExperiment) homes.push(resetArtifacts);
      const baselineHome = join(resetArtifacts, 'baseline');
      const homeProofPath = join(resetArtifacts, 'home-inputs.json');
      const rolloutMoves: Array<{ arm: string; original: string; archived: string; sha256: string; bytes: number }> = [];
      if (homeExperiment) {
        expect(initialHome.some(entry => /state_\d+\.sqlite$/.test(entry.path))).toBe(true);
        cpSync(nativeHome, baselineHome, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
          filter: path => !excluded.has(relative(nativeHome, path)) });
        expect(homeSnapshot(baselineHome)).toEqual(initialHome);
        for (const entry of initialHome.filter(entry => entry.kind === 'file')) {
          const original = lstatSync(join(nativeHome, entry.path)), copy = lstatSync(join(baselineHome, entry.path));
          expect(`${copy.dev}:${copy.ino}`).not.toBe(`${original.dev}:${original.ino}`);
        }
        for (const path of excluded) expect(existsSync(join(baselineHome, path))).toBe(false);
        if (mode === 'foreign-source-home') {
          // A copied state DB cannot fork a source outside its new home.
          // Preserve the native refusal instead of bypassing the path boundary.
          const foreign = await openNative(baselineHome);
          await expect(foreign.p.request({ method: 'thread/fork', params: { ...options, threadId: sourceId } }))
            .rejects.toThrow('must be in Codex home directory');
          expect(foreign.receipts.some(receipt => receipt.phase === 'write-started' && receipt.frame.method === 'turn/start')).toBe(false);
          expect(requests.map(request => request.phase)).toEqual(preparationPhases);
          await foreign.p.close(); await foreign.p.done; return;
        }
        nativeHomes.push(resetArtifacts);
        mkdirSync(join(resetArtifacts, 'sessions'));
        writeFileSync(homeProofPath, JSON.stringify({ initialHome, excluded: [...excluded], armOrder,
          scope: 'same-path closed local home byte restoration; guarded source/lock inodes preserved; not full runtime reset equivalence' }));
      }
      for (const arm of armOrder) {
        assertSourceGuards();
        const armPreflight = await captureCarrySourcePreflight({ source, sourceId: 'S-I0', receipts: preparation.receipts });
        expect(armPreflight.history).toEqual(sourcePreflight.history);
        expect(armPreflight.idle!.completedAtMs).toBe(sourcePreflight.idle!.completedAtMs);
        // Each arm starts from the same closed mutable bytes at the same paths.
        if (resetHome) expect(homeSnapshot(nativeHome)).toEqual(initialHome);
        const armStartedAt = processMonotonicClock.now();
        const live = await openNative();
        const opened = await live.p.request({ method: arm === 'control' ? 'thread/fork' : 'thread/start',
          params: { ...options, ...(arm === 'control' ? { threadId: sourceId } : {}) } });
        const thread = opened.thread as RpcFrame, threadId = String(thread.id);
        expect(threadId).not.toBe(sourceId);
        expect((thread.turns as RpcFrame[]).map(turn => turn.id)).toEqual(arm === 'control' ? [...sourceFiles].reverse().map(member => member.turnId) : []);
        const manifest = await captureManifest(live, threadId, { artifacts: [
          ...sourceFiles.map((s, i) => ({ id: `source-${i}`, filePath: s.filePath, maxBytes: s.snapshot.highWaterBytes })),
          { id: 'carry', filePath: carry.launchContextPath, maxBytes: 1024 * 1024 },
          { id: 'preparation-manifest', filePath: preparationManifestPath, maxBytes: 1024 * 1024 },
          { id: 'preparation-closeout', filePath: preparationCloseoutPath, maxBytes: 1024 * 1024 },
          ...(readSource ? [{ id: 'source-window', filePath: sourceWindowPath, maxBytes: 1024 * 1024 }] : []),
          ...(resetHome ? [{ id: 'home-inputs', filePath: homeProofPath, maxBytes: 1024 * 1024 }] : []),
        ], roots: [{ role: 'source', artifactIds: sourceFiles.map((_, i) => `source-${i}`) }] });
        expect(manifest.dependencyScope!.missingRoles).toEqual([]);
        expect(JSON.parse(readFileSync(preparationManifestPath, 'utf8'))).toEqual(preparationManifest);
        expect(JSON.parse(readFileSync(preparationCloseoutPath, 'utf8'))).toEqual(preparationCloseout);
        await recheckCarrySourceSnapshot(source);
        if (arm === 'candidate') {
          phase = 'carry'; await turn(live, threadId, carry.carryText, manifest);
        }
        phase = arm;
        const prompt = readSource ? `${task.prompt}\nRecovery reference: ${sourceWindow!.sourceRef}\nByte window: ${JSON.stringify(readArgs)}` : task.prompt;
        const result = await turn(live, threadId, prompt, manifest);
        // Check the native request actually carries the frozen task state for
        // each arm. Scripted expected output is only an oracle wiring test.
        const firstTaskRequest = requests.find(request => request.phase === arm)!;
        expect(JSON.stringify(firstTaskRequest.body.input)).toContain(JSON.stringify(recipe.seedText).slice(1, -1));
        expect(inspectCarryTaskResponse({ taskId: task.id, response: result.trace.finalResponse!,
          boundSourceRef: sourceWindow?.sourceRef }).matches).toBe(true);
        if (readSource) {
          expect(inspectCarrySourceRead(result.evidence, sourceWindow!)).toMatchObject({
            status: 'verified', missing: [], violations: [], sourceRef: sourceWindow!.sourceRef });
          expect(observedReads.filter(read => read.phase === arm)).toEqual([{ phase: arm, args: readArgs }]);
          const armRequests = requests.filter(request => request.phase === arm);
          expect(armRequests).toHaveLength(2);
          expect(JSON.stringify(armRequests[1].body.input)).toContain(Buffer.from(String(task.expected.sourceSentinel)).toString('base64'));
          // A correct scripted answer alone cannot prove source recovery. Both
          // witnesses must pass, and the source identity comes from the freeze.
          const missingRead = structuredClone(result.evidence);
          const persisted = ((missingRead.threadRead.thread as RpcFrame).turns as RpcFrame[]).find(turn => turn.id === result.turnId)!;
          persisted.items = (persisted.items as RpcFrame[]).filter(item => item.type !== 'mcpToolCall');
          expect(inspectCarrySourceRead(missingRead, sourceWindow!).status).not.toBe('verified');
          expect(inspectCarrySourceRead(result.evidence, { ...sourceWindow!, byteOffset: sourceWindow!.byteOffset + 1 }).status).not.toBe('verified');
          expect(inspectCarrySourceRead(result.evidence, { ...sourceWindow!, sha256: '0'.repeat(64) }).status).toBe('violation');
          expect(inspectCarryTaskResponse({ taskId: task.id, response: result.trace.finalResponse! })).toMatchObject({
            matches: null, missing: ['unbound-native-source-cut'] });
          expect(inspectCarryTaskResponse({ taskId: task.id, response: result.trace.finalResponse!,
            boundSourceRef: `codex:${randomUUID()}/${source.turnId}@${source.snapshot.sha256}` }).matches).toBe(false);
        }
        await live.p.close(); await live.p.done;
        if (resetHome) {
          await vi.waitFor(() => {
            for (const process of live.runtime.processes) expect(existsSync(`/proc/${process.pid}`)).toBe(false);
          }, { timeout: 5000 });
          const after = homeSnapshot(nativeHome);
          expect(after).not.toEqual(initialHome);
          const sqliteFamily = (entries: typeof after) => entries.filter(entry => /state_\d+\.sqlite(?:-(?:wal|shm))?$/.test(entry.path));
          expect(sqliteFamily(after)).not.toEqual(sqliteFamily(initialHome));
          const writes = runtimeBoundaries.filter(boundary => boundary.threadId === threadId)
            .flatMap(boundary => [...boundary.runtime.writableOpenFiles, ...boundary.runtime.writableSharedFiles]);
          expect(writes.length).toBeGreaterThan(0);
          expect(writes.every(path => path.startsWith(`${nativeHome}/`)), JSON.stringify(writes)).toBe(true);
        }
        if (switchModel) {
          // Inspect the native persisted context after close as well as the
          // actual HTTP request; a prompt label or scripted reply is no witness.
          const contexts = readFileSync(String((result.threadRead.thread as RpcFrame).path), 'utf8').trim().split('\n')
            .map(line => JSON.parse(line) as RpcFrame).filter(row => row.type === 'turn_context');
          expect(contexts.filter(row => (row.payload as RpcFrame).turn_id === result.turnId)
            .map(row => (row.payload as RpcFrame).model)).toEqual(['gpt-6-luna']);
          const previousTurn = arm === 'control' ? source.turnId
            : modelWitnesses.find(witness => witness.threadId === threadId && witness.phase === 'carry')!.turnId;
          if (arm === 'candidate') expect(contexts.filter(row => (row.payload as RpcFrame).turn_id === previousTurn)
            .map(row => (row.payload as RpcFrame).model)).toEqual(['gpt-6-sol']);
          expect(modelWitnesses.find(witness => witness.turnId === previousTurn)?.model).toBe('gpt-6-sol');
        }
        captures.push({ receipts: live.receipts, state: live.p.receiptState?.(), arms: [{ threadId, armId: arm }] });
        const armPopulation = inspectCarryNativePopulation(captures.at(-1)!);
        expect(armPopulation.status).toBe('closed-peer-reconciled');
        // Include candidate carry/startup writes as well as task/recovery writes.
        // Observe the HTTP send boundary; native turn/start is earlier and cannot
        // establish the idle gap. The whole gateway population is reconciled below.
        const armRows = gateway.stats().requestStages!.recent.filter(row => row.ownerId === owner &&
          row.nativeCorrelation.status === 'observed' && row.nativeCorrelation.threadId === threadId);
        const dispatches = armRows.flatMap(row => {
          expect(armPopulation.turns.some(turn => turn.turnId === row.nativeCorrelation.turnId)).toBe(true);
          expect(row.upstreamWrites.droppedCalls).toBe(0);
          expect(row.upstreamWrites.calls).toHaveLength(row.attempts);
          return row.upstreamWrites.calls.map(call => {
            expect(call).toMatchObject({ clockId: processMonotonicClock.id, matchedRequests: 1,
              unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0 });
            const headers = call.events.filter(event => event.phase === 'headers-write-start');
            expect(headers).toHaveLength(1);
            return { clockId: call.clockId, atMs: headers[0].atMs,
              evidenceRef: `gateway:${row.requestId}:call:${call.ordinal}:headers-write-start` };
          });
        }).sort((a, b) => a.atMs - b.atMs);
        expect(dispatches.length).toBeGreaterThan(0);
        const useful = live.receipts.filter(receipt => receipt.phase === 'received' && receipt.frame.method === 'item/completed' &&
          (receipt.frame.params as RpcFrame).threadId === threadId && (receipt.frame.params as RpcFrame).turnId === result.turnId &&
          ((receipt.frame.params as RpcFrame).item as RpcFrame).type === 'agentMessage' &&
          ((receipt.frame.params as RpcFrame).item as RpcFrame).text === result.trace.finalResponse);
        expect(useful).toHaveLength(1);
        const chargeToArmId = recipe.sources.find(source => source.id === 'S-I0')!.chargeToArmId;
        const measurement = measureCarryArmTiming({
          preparationStarted: { clockId: processMonotonicClock.id, atMs: preparationStartedAt,
            evidenceRef: `controller:${processMonotonicClock.id}:preparation-start` },
          predecessorCompleted: { clockId: armPreflight.idle!.clockId, atMs: armPreflight.idle!.completedAtMs,
            evidenceRef: armPreflight.idle!.evidenceRef },
          armStarted: { clockId: processMonotonicClock.id, atMs: armStartedAt,
            evidenceRef: `controller:${processMonotonicClock.id}:${arm}:start` },
          firstRequestDispatched: dispatches[0],
          firstUsefulResponse: { clockId: useful[0].clockId, atMs: useful[0].atMs,
            evidenceRef: `native:${useful[0].peerId}:${useful[0].sequence}` },
          preparationAllocation: chargeToArmId === `S-I0-${taskId}:${arm}` ? 'this-arm' : 'other-arm',
          allocationEvidenceRef: `recipe:${recipe.sha256}:${chargeToArmId}`, idleBand: 'under-60s',
        });
        expect(measurement.missing).toEqual([]);
        expect(['measured', 'out-of-band']).toContain(measurement.status);
        expect(measurement.metrics!.observedIdleMs).toBeGreaterThanOrEqual(armPreflight.idle!.ageMs);
        armTimings.push({ arm, preflightAgeMs: armPreflight.idle!.ageMs,
          firstDispatchRef: dispatches[0].evidenceRef, measurement });
        await recheckCarrySourceSnapshot(source);
        assertSourceGuards();
        if (resetHome) {
          const original = String((result.threadRead.thread as RpcFrame).path);
          expect(original.startsWith(`${nativeHome}/sessions/`)).toBe(true);
          expect(sourceFiles.some(member => member.filePath === original)).toBe(false);
          const bytes = readFileSync(original), sha256 = createHash('sha256').update(bytes).digest('hex');
          const archiveDir = join(resetArtifacts, 'sessions', arm); mkdirSync(archiveDir);
          const archived = join(archiveDir, basename(original)); renameSync(original, archived);
          expect(existsSync(original)).toBe(false);
          expect(createHash('sha256').update(readFileSync(archived)).digest('hex')).toBe(sha256);
          rolloutMoves.push({ arm, original, archived, sha256, bytes: bytes.length });
          // Destructive only inside this owned disposable fixture, after every
          // observed native writer exited and its new rollout was archived once.
          // Never replace the guarded source or held lock inode.
          const current = homeSnapshot(nativeHome);
          for (const entry of current.filter(entry => entry.kind !== 'directory')) rmSync(join(nativeHome, entry.path));
          const baselineDirs = new Set(initialHome.filter(entry => entry.kind === 'directory').map(entry => entry.path));
          for (const entry of [...current].reverse().filter(entry => entry.kind === 'directory' && !baselineDirs.has(entry.path))) {
            rmdirSync(join(nativeHome, entry.path));
          }
          cpSync(baselineHome, nativeHome, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
          expect(homeSnapshot(nativeHome)).toEqual(initialHome);
          expect(homeSnapshot(baselineHome)).toEqual(initialHome);
          expect(sourceInodes()).toEqual(frozenSourceInodes);
          await recheckCarrySourceSnapshot(source); assertSourceGuards();
        }
      }
      expect(requests.map(request => request.phase)).toEqual([...preparationPhases,
        ...armOrder.flatMap(arm => [...(arm === 'candidate' ? ['carry'] : []), arm, ...(readSource ? [arm] : [])])]);
      if (switchModel) expect(modelWitnesses.map(witness => [witness.phase, witness.model])).toEqual([
        ['preparation', 'gpt-6-sol'],
        ...armOrder.flatMap(arm => arm === 'candidate'
          ? [['carry', 'gpt-6-sol'], ['candidate', 'gpt-6-luna']]
          : [['control', 'gpt-6-luna']]),
      ]);
      expect(runtimeBoundaries.map(boundary => boundary.phase)).toEqual([
        ...preparationArms.flatMap(() => ['before-first-turn', 'preparation']),
        ...armOrder.flatMap(arm => ['before-first-turn', ...(arm === 'candidate' ? ['carry'] : []), arm]),
      ]);
      expect(runtimeBoundaries.every(boundary => boundary.runtime.writableOpenFiles.some(path => /\.sqlite(?:-wal)?$/.test(path)))).toBe(true);
      // The preparation closeout hashes its post-turn observation; each arm
      // also retains its boundary outputs separately from pre-dispatch inputs.
      // This cannot witness a file opened and closed between boundaries.
      const runtimeBoundarySha256 = createHash('sha256').update(JSON.stringify(runtimeBoundaries)).digest('hex');
      expect(failures).toEqual([]);
      // Full isolated gateway lifetime plus all native peers: no per-arm
      // filtering may hide preparation, failed attempts or a missing process.
      const org = await createOrgTestDb(), sql = org.adminSql;
      const workspace = `unpaid-carry-${randomUUID()}`;
      const dbSpy = vi.spyOn(dbOrg, 'getOrgPg').mockReturnValue({ sql } as ReturnType<typeof dbOrg.getOrgPg>);
      const workspaceSpy = vi.spyOn(workspaceRegistry, 'activeWorkspaceId').mockReturnValue(workspace);
      try {
        const adapters = nativeHomes.map(home => ({ name: 'codex', root: join(home, 'sessions'), parse: parseCodexChunk,
          replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }));
        expect((await ingestInteractiveUsage({ adapters, includeIsolationRoots: false })).errors).toEqual([]);
        const gatewayCapture = gateway.stats().requestStages!;
        const evidence = await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
          native: captures, gateway: gatewayCapture });
        expect(evidence).toMatchObject({ status: 'observations-linked', missing: [], violations: [],
          accountingComplete: false, admission: 'not-established' });
        expect(evidence.native.turns.map(turn => turn.armId)).toEqual([...preparationArms.map(arm => arm.armId),
          ...armOrder.flatMap(arm => arm === 'candidate' ? ['candidate', 'candidate'] : ['control'])]);
        expect(evidence.canonical!.rows).toHaveLength(4 + ancestorDepth + (readSource ? 2 : 0));
        expect(evidence.inheritedUsage).toEqual([]);
        expect(evidence.population!.turns.flatMap(turn => turn.usageEventKeys)).toHaveLength(4 + ancestorDepth + (readSource ? 2 : 0));
        expect((await ingestInteractiveUsage({ adapters, includeIsolationRoots: false })).samples).toBe(0);
        for (let omitted = 0; omitted < captures.length; omitted++) {
          const incomplete = await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
            native: captures.filter((_, index) => index !== omitted), gateway: gatewayCapture });
          expect(incomplete.status).not.toBe('observations-linked');
          expect(incomplete.population!.unmatchedGatewayRequestIds.length).toBeGreaterThan(0);
        }
      console.log('CARRY_UNPAID_PAIR_RECEIPT', JSON.stringify({ providerInference: false, taskId: task.id, sourceSha256: source.snapshot.sha256,
          armTimings, timingScope: 'local HTTP headers write to scripted task response; not remote receipt or natural-first-two acceptance',
          sourceReadCount: observedReads.length, sourceWindow, responseQuality: 'not-established',
          modelWitnesses, modelWitnessScope: 'native-client-request-and-persisted-context; no authenticated serving account',
          homeRestored: resetHome, armOrder, homeEntries: initialHome.length, rolloutMoves,
          homeInputSha256: resetHome ? createHash('sha256').update(readFileSync(homeProofPath)).digest('hex') : null,
          sourceAncestors: source.ancestors.length, manifestHashes: manifests.map(m => m.sha256),
          scriptCensus: manifests.map(manifest => ({ scriptArtifactIds: manifest.scriptCensus!.scriptArtifactIds,
            relativeTraversal: { rootArtifactIds: manifest.scriptCensus!.relativeTraversal!.rootArtifactIds,
              scannedScripts: manifest.scriptCensus!.relativeTraversal!.scannedArtifactIds.length,
              discoveredArtifacts: manifest.scriptCensus!.relativeTraversal!.artifacts.length },
            sites: manifest.scriptCensus!.sites.length,
            dispositions: Object.fromEntries([...new Set(manifest.scriptCensus!.sites.map(site => site.disposition))].sort()
              .map(disposition => [disposition, manifest.scriptCensus!.sites.filter(site => site.disposition === disposition).length])),
            runtimeClosureEstablished: false })),
          preparationManifestSha256: preparationManifest.sha256,
          runtimeBoundarySha256, runtimeBoundaryCount: runtimeBoundaries.length,
          sourceWriterGuardCount: sourceGuards.length, sourceWriterGuardScope: 'cooperating-native-thread-writers',
          mutableFileNames: [...new Set(runtimeBoundaries.flatMap(boundary => boundary.runtime.writableOpenFiles
            .map(path => path.slice(path.lastIndexOf('/') + 1))))].sort(),
          captureSha256: evidence.captureSha256, nativePeers: captures.length, nativeTurns: evidence.native.turns.length,
          canonicalRows: evidence.canonical!.rows.length, admission: evidence.admission, accountingComplete: false }));
      if (resetHome && switchModel) console.info('SOURCE_GUARD_HOLDER_PROBE', JSON.stringify({ mode, armOrder, observations: sourceGuardObservations }));
      } finally { dbSpy.mockRestore(); workspaceSpy.mockRestore(); await org?.cleanup(); }
    } finally {
      for (const guard of sourceGuards) { await guard.peer.close(); await guard.peer.done; }
      await gateway.close();
      for (const host of mcpHosts) await host.close();
      await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
      resetGovernorRegistry();
    }
  }, 120_000);

  it.each(['ok', 'failover', 'http-error', 'incomplete-stream', 'fork', 'fork-http-error'] as const)(
    'joins native turns to gateway HTTP write observations without provider inference (%s)', async mode => {
    const { createInferenceGateway } = await import('./inference-gateway/gateway');
    const { createFailoverPool } = await import('./inference-gateway/account-failover');
    const { resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');
    resetGovernorRegistry();
    const recipe = createCarryTrialRecipe(), task = recipe.tasks.find(task => task.id === 'T1')!;
    const forked = mode === 'fork' || mode === 'fork-http-error';
    let preparingSource = forked;
    let source: { threadId: string; turnId: string; path: string } | undefined;
    const expectedResponse = JSON.stringify(task.expected);
    const events: RpcFrame[] = [], receipts: SuStdioReceipt[] = [];
    const requests: Array<{ body: Record<string, unknown>; account: string }> = [];
    const fixtureErrors: string[] = [];
    const upstream = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const account = req.headers.authorization === 'Bearer PRIVATE_NATIVE_A' ? 'fixture-a'
          : req.headers.authorization === 'Bearer PRIVATE_NATIVE_B' ? 'fixture-b' : 'unexpected';
        requests.push({ body, account });
        if (!preparingSource && (mode === 'http-error' || mode === 'fork-http-error' || (mode === 'failover' && account === 'fixture-a'))) {
          res.writeHead(mode === 'failover' ? 429 : 503, { 'content-type': 'application/json', 'retry-after': '3600' });
          res.end(JSON.stringify({ error: { message: 'local native-gateway fixture refusal' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'incomplete-stream') {
          // HTTP can end normally while the native turn fails because no
          // response.completed arrived. Keep both observations in the join.
          res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-incomplete"}}\n\n');
        } else {
          res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
            text: preparingSource ? JSON.stringify(recipe.sourcePreparation.expectedAcknowledgement) : expectedResponse,
            inputTokens: preparingSource ? 600 : 1200, outputTokens: preparingSource ? 20 : 40 })));
        }
      } catch { fixtureErrors.push('local upstream fixture failed'); res.destroy(); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    const gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      upstreamBase: `http://127.0.0.1:${address.port}`, openaiUpstreamBase: `http://127.0.0.1:${address.port}`,
      codexPool: createFailoverPool([{ accountId: 'fixture-a', token: async () => 'PRIVATE_NATIVE_A' },
        { accountId: 'fixture-b', token: async () => 'PRIVATE_NATIVE_B' }]),
      concurrency: 2, maxQueueWaitMs: 2_000, requestAbsorbMs: 0, selfHeal: { enabled: false } });
    let p: SuStdioPeer | undefined;
    try {
      const port = await gateway.listen(0), owner = 'su-native-gateway-fixture';
      const config = stringifyToml({ model_provider: 'cache_protocol_probe', model_reasoning_effort: 'medium',
        model_providers: { cache_protocol_probe: { name: 'Local native-gateway fixture',
          base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false,
          http_headers: { 'x-papercusp-owner': owner }, supports_websockets: false,
          request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled',
      } as Parameters<typeof stringifyToml>[0]);
      p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config, receipt => receipts.push(receipt));
      await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_native_gateway_fixture', version: '1' } } });
      p.send({ method: 'initialized', params: {} });
      const start = await p.request({ method: 'thread/start', params: { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
      let threadId = String((start.thread as RpcFrame).id);
      if (forked) {
        const prepared = await p.request({ method: 'turn/start', params: { threadId,
          input: [{ type: 'text', text: recipe.sourcePreparation.prompt }] } });
        const preparedTurnId = String((prepared.turn as RpcFrame).id);
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed',
          params: expect.objectContaining({ threadId, turn: expect.objectContaining({ id: preparedTurnId, status: 'completed' }) }),
        })), { timeout: 20_000 });
        const preparedRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
        const preparedTrace = inspectCarryNativeTurn({ threadId, turnId: preparedTurnId, events, threadRead: preparedRead,
          allowedMcpCalls: [], expectedInputText: recipe.sourcePreparation.prompt });
        expect(preparedTrace.status).toBe('verified');
        expect(inspectCarryPreparationResponse(preparedTrace.finalResponse!).matches).toBe(true);
        source = { threadId, turnId: preparedTurnId, path: String((preparedRead.thread as RpcFrame).path) };
        const fork = await p.request({ method: 'thread/fork', params: { threadId, model: 'gpt-6-sol',
          modelProvider: 'cache_protocol_probe', cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
        threadId = String((fork.thread as RpcFrame).id);
        expect(threadId).not.toBe(source.threadId);
        expect((fork.thread as RpcFrame).turns).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: source.turnId, status: 'completed' }),
        ]));
        preparingSource = false;
      }
      const turnEventStart = events.length;
      const response = await p.request({ method: 'turn/start', params: { threadId,
        input: [{ type: 'text', text: task.prompt }] } });
      const turnId = String((response.turn as RpcFrame).id);
      const nativeStatus = mode === 'ok' || mode === 'failover' || mode === 'fork' ? 'completed' : 'failed';
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed',
        params: expect.objectContaining({ threadId, turn: expect.objectContaining({ id: turnId, status: nativeStatus }) }),
      })), { timeout: 20_000 });
      const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
      // Bound action validation to this turn's capture window, retaining any
      // unexpected events within it. Population closeout uses ALL receipts.
      const trace = inspectCarryNativeTurn({ threadId, turnId, events: events.slice(turnEventStart), threadRead,
        allowedMcpCalls: [], expectedInputText: task.prompt });
      if (nativeStatus === 'completed') {
        expect(trace, JSON.stringify({ missing: trace.missing, violations: trace.violations }))
          .toMatchObject({ status: 'verified', finalResponse: expectedResponse });
        expect(inspectCarryTaskResponse({ taskId: task.id, response: trace.finalResponse! }).matches).toBe(true);
      } else {
        expect(trace.status).not.toBe('verified');
        expect(trace.finalResponse).toBeNull();
      }
      await vi.waitFor(() => expect(gateway.stats().requestStages!.recent).toHaveLength(forked ? 2 : 1));
      const stages = gateway.stats().requestStages!;
      const timeline = stages.recent.find(row => row.nativeCorrelation.threadId === threadId)!;
      expect(stages.requests).toMatchObject({ active: 0, reconciled: true });
      expect(timeline).toMatchObject({ ownerId: owner, protocol: 'openai-responses', transport: 'bearer-http',
        nativeCorrelation: { status: 'observed', threadId, turnId } });
      const accounts = mode === 'failover' ? ['fixture-a', 'fixture-b'] : ['fixture-a'];
      expect(requests.map(request => request.account)).toEqual(forked ? ['fixture-a', ...accounts] : accounts);
      expect(timeline.upstreamWrites.calls.map(call => call.accountId)).toEqual(accounts);
      expect(timeline.upstreamWrites.calls.map(call => call.responseStatus)).toEqual(
        mode === 'failover' ? [429, 200] : nativeStatus === 'failed' && mode !== 'incomplete-stream' ? [503] : [200]);
      expect(timeline.upstreamWrites.droppedCalls).toBe(0);
      for (const call of timeline.upstreamWrites.calls) {
        expect(call).toMatchObject({ matchedRequests: 1, unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0 });
        expect(call.events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
      }
      for (const [index, request] of requests.entries()) {
        const metadata = JSON.parse((request.body.client_metadata as Record<string, string>)['x-codex-turn-metadata']);
        expect(metadata).toMatchObject(forked && index === 0
          ? { thread_id: source!.threadId, turn_id: source!.turnId } : { thread_id: threadId, turn_id: turnId });
        expect(request.body).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'medium' } });
      }
      // A gateway failover creates two upstream sends for ONE native request;
      // never count the local request id as a unique charged-request identity.
      const writes = receipts.filter(receipt => receipt.phase === 'write-started' && receipt.frame.method === 'turn/start' &&
        (receipt.frame.params as RpcFrame).threadId === threadId);
      expect(writes).toHaveLength(1);
      const terminal = receipts.filter(receipt => receipt.phase === 'received' && receipt.frame.method === 'turn/completed' &&
        (receipt.frame.params as RpcFrame).threadId === threadId &&
        ((receipt.frame.params as RpcFrame).turn as RpcFrame).id === turnId);
      expect(terminal).toHaveLength(1);
      for (const call of timeline.upstreamWrites.calls) {
        expect(call.clockId).toBe(writes[0].clockId);
        expect(call.clockId).toBe(processMonotonicClock.id);
        expect(call.events[0].atMs).toBeGreaterThanOrEqual(writes[0].atMs);
        expect(call.events.at(-1)!.atMs).toBeLessThanOrEqual(terminal[0].atMs);
      }
      if (nativeStatus === 'completed') {
        const useful = receipts.filter(receipt => receipt.phase === 'received' && receipt.frame.method === 'item/completed' &&
          (receipt.frame.params as RpcFrame).threadId === threadId && (receipt.frame.params as RpcFrame).turnId === turnId &&
          ((receipt.frame.params as RpcFrame).item as RpcFrame).type === 'agentMessage' &&
          ((receipt.frame.params as RpcFrame).item as RpcFrame).text === expectedResponse);
        expect(useful).toHaveLength(1);
        expect(timeline.upstreamWrites.calls.at(-1)!.events.at(-1)!.atMs).toBeLessThanOrEqual(useful[0].atMs);
        expect(useful[0].atMs).toBeLessThanOrEqual(terminal[0].atMs);
      }
      expect(JSON.stringify(timeline)).not.toMatch(/PRIVATE_NATIVE|From the inherited task state/);
      expect(fixtureErrors).toEqual([]);
      // Flush only this test's native process and ingest only its isolated home.
      // This exercises the real canonical writer, not a fabricated billing row.
      const nativeHome = homes.at(-1)!;
      if (source && nativeStatus === 'completed') {
        const frozen = await captureCompletedCarrySource(p, threadId, turnId);
        expect(frozen).toMatchObject({ forkedFromId: source.threadId, ancestors: [
          { threadId: source.threadId, turnId: source.turnId, filePath: source.path, forkedFromId: null },
        ] });
        await recheckCarrySourceSnapshot(frozen);
        const parentBytes = readFileSync(source.path);
        try {
          writeFileSync(source.path, Buffer.concat([parentBytes, Buffer.from('{}\n')]));
          await expect(recheckCarrySourceSnapshot(frozen)).rejects.toThrow();
        } finally { writeFileSync(source.path, parentBytes); }
        await recheckCarrySourceSnapshot(frozen);
      } else await p.close();
      const arms = [...(source ? [{ armId: 'preparation', threadId: source.threadId }] : []),
        { armId: `fixture:${mode}`, threadId }];
      const nativeCapture = { receipts, state: p.receiptState?.(), arms };
      const nativePopulation = inspectCarryNativePopulation(nativeCapture);
      expect(nativePopulation).toMatchObject({ status: 'closed-peer-reconciled', missing: [], violations: [],
        turns: [...(source ? [{ armId: 'preparation', threadId: source.threadId, turnId: source.turnId, status: 'completed' }] : []),
          { threadId, turnId, status: nativeStatus }] });
      expect(inspectCarryNativePopulation({ receipts: receipts.slice(0, -1), state: p.receiptState?.(),
        arms }).status).not.toBe('closed-peer-reconciled');
      if (source) {
        expect(nativePopulation.threads).toEqual([
          { threadId: source.threadId, sourcePath: source.path, inheritedTurnIds: [] },
          { threadId, sourcePath: (threadRead.thread as RpcFrame).path, inheritedTurnIds: [source.turnId] },
        ]);
      }
      peers.splice(peers.indexOf(p), 1); p = undefined;
      const transcriptPath = String((threadRead.thread as RpcFrame).path);
      const parsed = parseCodexChunk(readFileSync(transcriptPath, 'utf8'));
      const usageEvents = parsed.events ?? [];
      expect(usageEvents).toHaveLength(nativeStatus === 'completed' ? 1 : 0);
      if (nativeStatus === 'completed') {
        expect(usageEvents.at(-1)).toMatchObject({ turnId, inputTotalTokens: 1200,
          usage: { outputTokens: 40 }, requestOrdinal: 1 });
      }
      if (source) {
        // Installed native forks retain a parent link; thread/read resolves
        // inherited turns without copying their token events into child JSONL.
        expect(parsed.parserState?.predecessorSessionId).toBe(source.threadId);
        expect(usageEvents.some(event => event.turnId === source!.turnId)).toBe(false);
        expect(parseCodexChunk(readFileSync(source.path, 'utf8')).events).toMatchObject([
          { turnId: source.turnId, inputTotalTokens: 600, usage: { outputTokens: 20 }, requestOrdinal: 1 },
        ]);
      }
      const org = await createOrgTestDb();
      const sql = org.adminSql, workspace = `native-carry-${randomUUID()}`;
      const dbSpy = vi.spyOn(dbOrg, 'getOrgPg').mockReturnValue({ sql } as ReturnType<typeof dbOrg.getOrgPg>);
      const workspaceSpy = vi.spyOn(workspaceRegistry, 'activeWorkspaceId').mockReturnValue(workspace);
      let canonicalSamples = 0;
      try {
        const adapters = [{ name: 'codex', root: join(nativeHome, 'sessions'), parse: parseCodexChunk,
          replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }];
        const first = await ingestInteractiveUsage({ adapters, includeIsolationRoots: false });
        expect(first.errors).toEqual([]);
        const rows = await sql<Array<CarryCanonicalUsageRow & { account_id: string | null; cost_usd: number | null;
          cost_source: string | null; output_tokens: number }>>`SELECT session_id, usage_event_key, account_id, cost_usd, cost_source,
          output_tokens, usage_provenance FROM harness_shared.agent_usage_samples
          WHERE workspace_id = ${workspace} ORDER BY id`;
        canonicalSamples = rows.length;
        expect(rows).toHaveLength(usageEvents.length + (source ? 1 : 0));
        const canonicalPopulation = await captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace, native: nativePopulation });
        expect(canonicalPopulation).toMatchObject({ coverage: 'complete-selected-snapshot',
          ingestionCoverage: 'not-established', accountingComplete: false });
        expect(canonicalPopulation.rows).toEqual(rows.map(({ session_id, usage_event_key, usage_provenance }) =>
          ({ session_id, usage_event_key, usage_provenance })));
        const evidence = await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
          native: nativeCapture, gateway: stages });
        const inheritedRows = source ? rows.filter(row => row.session_id === threadId && row.usage_provenance?.turnId === source!.turnId) : [];
        expect(evidence).toMatchObject({ status: 'observations-linked', violations: [], missing: [],
          native: nativePopulation, canonical: canonicalPopulation, accountingComplete: false, admission: 'not-established' });
        expect(evidence.inheritedUsage).toEqual(inheritedRows.map(({ session_id, usage_event_key, usage_provenance }) =>
          ({ session_id, usage_event_key, usage_provenance })));
        expect(inheritedRows).toHaveLength(0);
        expect(evidence.captureSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_NATIVE|From the inherited task state/);
        const population = evidence.population!;
        expect(population).toMatchObject({ populationStatus: 'linked', missing: [], violations: [],
          chargeJoin: 'unavailable', accountingComplete: false, unmatchedGatewayRequestIds: [], unmatchedUsageRows: [] });
        const currentRows = rows.filter(row => row.session_id === threadId && row.usage_provenance?.turnId === turnId);
        const currentTurn = population.turns.find(turn => turn.threadId === threadId)!;
        expect(currentTurn).toMatchObject({ status: nativeStatus, gatewayRequestIds: [timeline.requestId],
          usageEventKeys: currentRows.map(row => row.usage_event_key) });
        expect(currentTurn.upstreamAttempts.map(call => call.responseStatus)).toEqual(
          timeline.upstreamWrites.calls.map(call => call.responseStatus));
        if (source) {
          const preparationRows = rows.filter(row => row.session_id === source!.threadId);
          expect(preparationRows).toMatchObject([{ output_tokens: 20, account_id: null, cost_source: 'estimated',
            usage_provenance: { turnId: source.turnId, inputTotalTokens: 600, grain: 'request' } }]);
          expect(population.turns).toHaveLength(2);
          expect(population.turns.find(turn => turn.threadId === source!.threadId)).toMatchObject({ armId: 'preparation',
            turnId: source.turnId, status: 'completed', usageEventKeys: preparationRows.map(row => row.usage_event_key) });
          expect(new Set(rows.map(row => row.usage_event_key)).size).toBe(rows.length);
          // Source preparation remains in its own usage partition even
          // though its inherited turn is visible from the child's native read.
          expect(currentTurn.usageEventKeys).not.toContain(preparationRows[0].usage_event_key);
          expect(preparationRows.length + inheritedRows.length + currentRows.length).toBe(rows.length);
          await expect(captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
            native: { ...nativeCapture, arms: [{ armId: `fixture:${mode}`, threadId }] }, gateway: stages }))
            .resolves.toMatchObject({ status: 'invalid', canonical: null, population: null, accountingComplete: false });
        }
        if (nativeStatus === 'completed') {
          const row = currentRows[0], event = usageEvents.at(-1)!;
          expect(row).toMatchObject({ session_id: threadId, account_id: null, cost_source: 'estimated',
            output_tokens: 40, usage_provenance: { turnId, sourceId: event.sourceId,
              inputTotalTokens: 1200, accountSource: 'unavailable', grain: 'request' } });
          expect(Number(row.cost_usd)).toBeGreaterThan(0);
          expect(row.usage_event_key).toBe(createHash('sha256')
            .update(JSON.stringify([transcriptPath, 0, event.model, event.sourceId])).digest('hex'));
        }
        const again = await ingestInteractiveUsage({ adapters, includeIsolationRoots: false });
        expect(again).toMatchObject({ errors: [], samples: 0 });
        const [{ count }] = await sql`SELECT count(*)::int AS count FROM harness_shared.agent_usage_samples
          WHERE workspace_id = ${workspace}`;
        expect(count).toBe(canonicalSamples);
        // A failed attempt is retained by the gateway even when the native
        // transcript contains no usage. No sample means unknown charge, not zero.
        expect(timeline.upstreamWrites.calls.length).toBeGreaterThanOrEqual(currentRows.length);
        if (mode === 'failover') expect(timeline.upstreamWrites.calls.length).toBe(canonicalSamples + 1);
        if (mode === 'ok') {
          // A filtered-to-known-turn query would hide these rows. Exercise all
          // three scope keys and the workspace boundary against real Postgres.
          const invalidRows = [
            { workspace_id: workspace, session_id: threadId, run_id: null, usage_provenance: { turnId: 'inherited-or-unknown' } },
            { workspace_id: workspace, session_id: 'wrong-session', run_id: null, usage_provenance: { sourceFile: transcriptPath } },
            { workspace_id: workspace, session_id: null, run_id: threadId, usage_provenance: null },
            { workspace_id: `foreign-${workspace}`, session_id: threadId, run_id: threadId, usage_provenance: { sourceFile: transcriptPath } },
          ];
          for (const row of invalidRows) await sql`
            INSERT INTO harness_shared.agent_usage_samples
              (workspace_id, ts, bucket_key, provider, model_class, source, session_id, run_id, usage_provenance)
            VALUES (${row.workspace_id}, 1, 'fixture', 'codex', 'fixture', 'interactive', ${row.session_id},
              ${row.run_id}, ${row.usage_provenance ? sql.json(row.usage_provenance) : null})`;
          const expanded = await captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace, native: nativePopulation, maxRows: 4 });
          expect(expanded.rows).toHaveLength(4);
          expect(expanded.rows.filter(r => r.usage_event_key === null)).toHaveLength(3);
          expect(inspectCarryRequestPopulation({ ownerId: owner, turns: nativePopulation.turns,
            gateway: stages, usage: expanded.rows })).toMatchObject({ populationStatus: 'invalid', unmatchedUsageRows: [1, 2, 3] });
          expect(await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
            native: nativeCapture, gateway: stages })).toMatchObject({ status: 'invalid', inheritedUsage: [],
            population: { unmatchedUsageRows: [1, 2, 3] }, accountingComplete: false });
          await expect(captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace, native: nativePopulation, maxRows: 3 }))
            .rejects.toThrow('exceeded bound or lost rows');
          await expect(captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace,
            native: { ...nativePopulation, status: 'incomplete' } })).rejects.toThrow('requires a reconciled native scope');
        }
        if (nativeStatus === 'failed') expect(timeline.upstreamWrites.calls.length).toBeGreaterThan(0);
      } finally {
        dbSpy.mockRestore(); workspaceSpy.mockRestore();
        await org?.cleanup();
      }
      console.log('CARRY_NATIVE_GATEWAY_RECEIPT', JSON.stringify({ mode, threadId, turnId, nativeStatus,
        gatewayRequestId: timeline.requestId, upstreamAttempts: timeline.upstreamWrites.calls.length,
        selectedAccounts: accounts, gatewayOutcome: timeline.outcome, providerInference: false,
        canonicalUsageSamples: canonicalSamples, inheritedUsageSamples: 0,
        preparationThreadId: source?.threadId ?? null, canonicalChargeJoin: false, colocatedClockBound: true }));
    } finally {
      try { if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); } }
      finally {
        await gateway.close();
        await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
        resetGovernorRegistry();
      }
    }
  }, 90_000);

  it.each(['invalid-request', 'retryable-http', 'incomplete-stream'] as const)(
    'Codex preserves native turn metadata and disables retries for %s without provider inference', async (failure) => {
    const requests: Array<Record<string, unknown>> = [];
    const events: RpcFrame[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // An intentional local refusal ends this wire-format probe. No provider,
      // credential, model inference, or synthetic charged-usage record is used.
      if (failure === 'incomplete-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"local-probe"}}\n\n');
        return;
      }
      res.writeHead(failure === 'retryable-http' ? 500 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'local protocol probe complete', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const overrides = {
        model_provider: 'cache_protocol_probe',
        'model_providers.cache_protocol_probe.name': 'Local protocol fixture',
        'model_providers.cache_protocol_probe.base_url': `http://127.0.0.1:${address.port}/v1`,
        'model_providers.cache_protocol_probe.wire_api': 'responses',
        'model_providers.cache_protocol_probe.requires_openai_auth': false,
        'model_providers.cache_protocol_probe.supports_websockets': false,
        'model_providers.cache_protocol_probe.request_max_retries': 0,
        'model_providers.cache_protocol_probe.stream_max_retries': 0,
        'features.apps': false,
        'features.shell_tool': false,
        web_search: 'disabled',
      };
      p = await peer('codex', ['app-server', ...Object.entries(overrides).flatMap(([key, value]) =>
        ['-c', `${key}=${JSON.stringify(value)}`])], {}, (frame) => events.push(frame));
      await p.request({ method: 'initialize', params: {
        clientInfo: { name: 'papercusp_cache_protocol_test', version: '1' },
        capabilities: { experimentalApi: true },
      } });
      p.send({ method: 'initialized', params: {} });
      const started = await p.request({ method: 'thread/start', params: {
        model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only',
      } });
      const threadId = (started.thread as RpcFrame).id;
      const turn = await p.request({ method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'Offline wire-format probe; the local endpoint will refuse.' }],
        responsesapiClientMetadata: { cache_eval_case: 'native-correlation-control' },
      } });
      const turnId = (turn.turn as RpcFrame).id;
      // Waiting for terminal failure, rather than only the first request, catches
      // both HTTP and stream retries that would otherwise escape an arm's budget.
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          threadId, turn: expect.objectContaining({ id: turnId, status: 'failed' }),
        }),
      })), { timeout: 20_000 });
      expect(requests).toHaveLength(1);
      const clientMetadata = requests[0].client_metadata as Record<string, string>;
      const metadata = JSON.parse(clientMetadata['x-codex-turn-metadata']) as Record<string, string>;
      expect(metadata).toMatchObject({
        thread_id: threadId,
        turn_id: turnId,
        cache_eval_case: 'native-correlation-control',
      });
      const telemetry = new GatewayRequestTelemetry();
      const observation = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      observation.setNativeCorrelation(requests[0]);
      const correlated = observation.finish('upstream-error', failure === 'retryable-http' ? 500 : 400)!;
      const fieldShapes = Object.fromEntries(['session_id', 'thread_id', 'turn_id', 'window_id'].map(key =>
        [key, { type: typeof metadata[key], length: metadata[key]?.length, isNull: metadata[key] === null,
          suffix: key === 'window_id' ? metadata[key]?.slice(36, 48) : undefined,
          uuid: typeof metadata[key] === 'string' && /^[0-9a-f-]{36}$/i.test(metadata[key]) }]));
      expect(correlated.nativeCorrelation, JSON.stringify(fieldShapes)).toMatchObject({ status: 'observed', threadId, turnId });
      expect(correlated.cache.servingAccountId).toBeNull(); // loopback has no serving account
      expect(JSON.stringify(correlated)).not.toContain('native-correlation-control');
    } finally {
      try {
        if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); }
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);

  it('Codex accepts the SU launch flags and app-server handshake', async () => {
    const p = await peer('codex', ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'app-server']);
    let init: RpcFrame;
    try { init = await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_pui', version: '1' } } }); }
    catch (error) { throw new Error(`${String(error)}; native startup diagnostic: ${processState.stderr}`); }
    expect(init).toHaveProperty('userAgent');
    p.send({ method: 'initialized', params: {} });
    const started = await p.request({ method: 'thread/start', params: { cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'danger-full-access' } });
    expect(started).toMatchObject({ thread: { id: expect.any(String) }, model: expect.any(String) });
    // A real id exists before the first turn creates its rollout. Readiness
    // must not be presented as persisted exact-resume support in this window.
    await expect(p.request({ method: 'thread/resume', params: { threadId: (started.thread as RpcFrame).id } }))
      .rejects.toThrow('no rollout found');
    const servers = await p.request({ method: 'mcpServerStatus/list', params: {} });
    expect(Array.isArray(servers.data)).toBe(true);
  }, 90_000);

});

describe('OMP native protocol startup', () => {
  it('exposes its assigned session and tool catalog through RPC without provider credentials', async () => {
    // The peer helper sets PI_CODING_AGENT_DIR to the supplied home. Seed a
    // loopback-only model there so the handshake never depends on ambient user
    // configuration or credentials and cannot issue provider inference.
    const home = mkdtempSync(join(tmpdir(), 'pui-omp-protocol-'));
    homes.push(home);
    const providerRequests: string[] = [];
    const server = createServer((req, res) => {
      providerRequests.push(`${req.method} ${req.url}`);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Offline protocol fixture: provider requests are not allowed.');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing OMP fixture loopback listener');
    writeFileSync(join(home, 'config.yml'), [
      'modelRoles:',
      '  default: pui-protocol-fixture/fixture-model',
      '',
    ].join('\n'));
    writeFileSync(join(home, 'models.yml'), [
      'providers:',
      '  pui-protocol-fixture:',
      `    baseUrl: "http://127.0.0.1:${address.port}"`,
      '    apiKey: "offline-fixture"',
      '    api: openai-responses',
      '    auth: apiKey',
      '    models:',
      '      - id: fixture-model',
      '        name: Offline protocol fixture',
      '        api: openai-responses',
      '        input: [text]',
      '        contextWindow: 64000',
      '        maxTokens: 1024',
      '',
    ].join('\n'));
    let p: SuStdioPeer | undefined;
    try {
      p = await peer('omp', ['--mode', 'rpc', '--no-title', '--no-extensions', '--no-skills', '--no-lsp', '--no-session'],
        { HOME: home, USERPROFILE: home }, undefined, undefined, undefined, home);
      let state: RpcFrame;
      try { state = await p.request({ type: 'get_state' }); }
      catch (error) { throw new Error(`${String(error)}; native startup diagnostic: ${processState.stderr}`); }
      expect(state).toMatchObject({ sessionId: expect.any(String), model: { id: expect.stringContaining('fixture-model') }, dumpTools: expect.any(Array) });
      await expect(p.request({ type: 'abort' })).resolves.toEqual({});
      expect(providerRequests).toEqual([]);
    } finally {
      try {
        if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);
});
