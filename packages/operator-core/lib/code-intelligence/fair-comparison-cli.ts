import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * P-017 Phase E driver (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011..D-016). Run from the repo root:
 *
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts prereg --out <dir> [--reps 3] [--seed 20261006]
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts run --arm <id> --out <dir>
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts score --out <dir>
 *   npx tsx packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts adjudicate --out <dir>
 *
 * `adjudicate` runs the pooled-adjudication assistant (fair-comparison-adjudicate.ts) over
 * `pending.json`, merges its verdicts into `verdicts.json` without rewriting a recorded one, and
 * lists what it left for hand review in `adjudication-undecided.json`. Re-run `score` after it.
 *
 * `prereg` freezes corpus, seed keys, arms (version + intents), reps and bars
 * into `<dir>/prereg.json` BEFORE any arm runs; `run` refuses anything that
 * differs. Run ONE arm per process: the in-process arms report the process's
 * peak RSS. Each arm indexes its own hardlinked copy of the frozen snapshot
 * (`<bench>/trees/<arm>`, D-013 rule 4) with its own HOME, and the copy carries
 * what `npm install` gives a real checkout for workspace packages
 * (node_modules/<name> links) plus a single git commit, identical for every arm.
 * `score` pools answers, writes `pending.json` (sites awaiting adjudication) and
 * `report.json`; verdicts go in `verdicts.json` as { caseId: AdjudicationVerdict[] }.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, loadavg } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ArmDeps } from './engine-comparison-arms';
import { hashCases, hashKeys, hashPreregistration, preregister, type AnswerKey, type AdjudicationVerdict, type ArmCapabilities, type Preregistration } from './fair-comparison';
import { admitArm } from './fair-comparison-admission';
import { createRgFairArm, type FairArm } from './fair-comparison-arms';
import { FAIR_CORPUS, FAIR_CORPUS_COMMIT, initialKeys } from './fair-comparison-corpus';
import { createCbmFairArm, createCgcArm, createCodegraphArm, createGitnexusFairArm, createTraceMcpArm } from './fair-comparison-engines';
import { createLspQueryArm, createNoThirdPartyArm, loadVendoredTypescript } from './fair-comparison-first-party';
import { acquireArmRunLock } from './fair-comparison-lock';
import { runArm, scoreRuns, type ArmRun, type FairArmFactory, type PendingSites, type ResourceStage, type ArmResourceSample } from './fair-comparison-run';
import type { ArmAnswer, FairCase } from './fair-comparison';
import { readProcessIdentity } from '../process-identity';
import { absCgroupDir, readProcessCgroupPath, walkCgroupTree, type CgroupFs } from '../task-manager/cgroup-read';
import { taskIdFromScopeUnit } from '../task-manager/types';

export interface FrozenFairInputs {
  readonly preregistration: Preregistration;
  readonly cases: readonly FairCase[];
  readonly keys: readonly AnswerKey[];
  readonly controlFiles: Readonly<Record<string, string>>;
  readonly sourcePins: readonly { readonly path: string; readonly sha256: string; readonly commit: string }[];
}

/** Verify the saved edition without regenerating questions, keys or controls. */
export function validateFrozenInputs(inputs: FrozenFairInputs): FrozenFairInputs {
  const registered = inputs.preregistration;
  if (!registered?.protocol || hashPreregistration(registered) !== registered.hash)
    throw new Error('frozen protocol content differs from its recorded hash');
  if (hashCases(inputs.cases) !== registered.corpusHash || hashKeys(inputs.keys) !== registered.keyHash)
    throw new Error('frozen cases or keys differ from preregistration');
  const files = Object.entries(inputs.controlFiles);
  if (files.some(([path, text]) => !path || path.startsWith('/') || path.includes('\\') ||
    path.split('/').some(part => part === '..' || part === '.') || typeof text !== 'string'))
    throw new Error('frozen control file path or bytes invalid');
  const fixtureHash = createHash('sha256').update(JSON.stringify(files.sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  if (fixtureHash !== registered.protocol.fixtureHash)
    throw new Error('frozen control bytes differ from protocol fixture hash');
  if (!inputs.sourcePins?.length || inputs.sourcePins.some(pin => pin.commit !== registered.protocol!.sourceCommit ||
    !/^[a-f0-9]{64}$/.test(pin.sha256) || !pin.path || pin.path.startsWith('/') || pin.path.includes('\\') ||
    pin.path.split('/').some(part => part === '..' || part === '.')))
    throw new Error('frozen source custody needs safe pins at the protocol commit');
  return inputs;
}

/** A directory name is not a source witness: check the frozen donor bytes. */
export async function verifyFrozenSource(tree: string, inputs: FrozenFairInputs): Promise<void> {
  validateFrozenInputs(inputs);
  for (const pin of inputs.sourcePins) {
    const actual = createHash('sha256').update(await readFile(join(tree, pin.path))).digest('hex');
    if (actual !== pin.sha256) throw new Error(`frozen snapshot source mismatch: ${pin.path}`);
  }
}

/** Protocol editions require their complete frozen bundle, never the old corpus. */
export async function loadFairInputs(out: string, frozenPath?: string): Promise<FrozenFairInputs> {
  if (frozenPath) {
    const frozen = validateFrozenInputs(JSON.parse(await readFile(frozenPath, 'utf8')) as FrozenFairInputs);
    if (existsSync(join(out, 'prereg.json'))) {
      const saved = JSON.parse(await readFile(join(out, 'prereg.json'), 'utf8')) as Preregistration;
      if (hashPreregistration(saved) !== saved.hash || saved.hash !== frozen.preregistration.hash)
        throw new Error('output preregistration differs from frozen edition');
    }
    return frozen;
  }
  const registered = JSON.parse(await readFile(join(out, 'prereg.json'), 'utf8')) as Preregistration;
  if (registered.protocol) throw new Error('protocol run requires --frozen with its saved cases, keys and controlFiles');
  return { preregistration: registered, cases: FAIR_CORPUS.map(entry => entry.kase),
    keys: initialKeys(FAIR_CORPUS), controlFiles: {}, sourcePins: [] };
}

export async function materializeFrozenControls(tree: string, inputs: FrozenFairInputs): Promise<void> {
  validateFrozenInputs(inputs);
  for (const [path, text] of Object.entries(inputs.controlFiles)) {
    await mkdir(dirname(join(tree, path)), { recursive: true });
    await writeFile(join(tree, path), text);
  }
}

/** Replay a saved repository question only on its preregistered source bytes.
 * Configuration and process custody are separate witnesses, never implied by
 * materializing one file or by a directory whose name contains a commit.
 */
export async function materializeFrozenRepositoryTask(tree: string, kase: FairCase,
  inputs: FrozenFairInputs, source: string) {
  validateFrozenInputs(inputs);
  const frozen = inputs.cases.find(candidate => candidate.id === kase.id);
  if (!frozen || hashCases([frozen]) !== hashCases([kase]) || kase.source !== 'repository-task')
    throw new Error('repository task differs from frozen question');
  const pin = inputs.sourcePins.find(candidate => candidate.path === kase.anchorFile);
  const contentHash = createHash('sha256').update(source).digest('hex');
  if (!pin || pin.sha256 !== kase.sourceFingerprint || pin.sha256 !== contentHash)
    throw new Error('repository task source differs from frozen pin');
  await mkdir(dirname(join(tree, pin.path)), { recursive: true });
  await writeFile(join(tree, pin.path), source);
  return { path: pin.path, contentHash, sourceCommit: pin.commit, taskRef: kase.taskRef };
}

let fairToolTokenizer: import('js-tiktoken').Tiktoken | undefined;

/** Exact JSON tool-payload footprint, separate from provider-billed LLM usage
 * and from the protocol's existing bytes/4 estimate. Hashes bind the count to
 * the preserved raw request/response, including refusals and non-ASCII text.
 */
export async function measureFairToolPayload(request: unknown, response: unknown) {
  const requestJson = JSON.stringify(request), responseJson = JSON.stringify(response);
  if (requestJson === undefined || responseJson === undefined)
    throw new Error('tool payload must have a JSON representation');
  const { getEncoding } = await import('js-tiktoken');
  const tokenizer = fairToolTokenizer ??= getEncoding('o200k_base');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return { serialization: 'JSON.stringify' as const, encoding: 'o200k_base' as const,
    requestTokens: tokenizer.encode(requestJson).length,
    responseTokens: tokenizer.encode(responseJson).length,
    requestBytes: Buffer.byteLength(requestJson), responseBytes: Buffer.byteLength(responseJson),
    requestHash: hash(requestJson), responseHash: hash(responseJson),
    scope: 'raw-tool-payload-only' as const };
}

/** Native replay cannot accept a changed question or silently route text search
 * through compiler topology. Keep this separate from the frozen backend arms. */
export function frozenGraphRequest(kase: FairCase, inputs: FrozenFairInputs) {
  validateFrozenInputs(inputs);
  const saved = inputs.cases.find(candidate => candidate.id === kase.id);
  if (!saved || hashCases([saved]) !== hashCases([kase]))
    throw new Error('native graph question differs from frozen case');
  const operations = { callers: 'callers', callees: 'callees', definition: 'symbol', impact: 'impact' } as const;
  if (!(kase.intent in operations) || !kase.anchorFile)
    throw new Error(`native graph replay does not cover ${kase.intent}`);
  return { op: operations[kase.intent as keyof typeof operations], name: kase.subject,
    file_path: kase.anchorFile, paths: [kase.anchorFile], limit: 100 };
}

async function replayFrozenGraphTask(tree: string, kase: FairCase, inputs: FrozenFairInputs) {
  const request = frozenGraphRequest(kase, inputs);
  // Repository tasks retain the complete pinned donor; authored controls reuse
  // the existing original/stale/deleted/configuration transition mechanism.
  const control = kase.source === 'repository-task' ? null : await prepareFrozenControl(tree, kase, inputs);
  if (kase.source === 'repository-task') await verifyFrozenSource(tree, inputs);
  const sourceHash = kase.sourceState === 'deleted' ? null : createHash('sha256')
    .update(await readFile(join(tree, kase.anchorFile!))).digest('hex');
  if (kase.source === 'repository-task' && sourceHash !== kase.sourceFingerprint)
    throw new Error('native graph repository source differs from frozen case');
  const graph = (await import('../agent-tools/gitnexus/query')).default;
  const parsed = graph.args.parse(request);
  const started = performance.now();
  const response = (await graph.handler(parsed, { projectDir: tree } as never) as {
    data: import('./contracts').CodeIntelAnswer;
  }).data;
  return { tool: 'graph:query' as const, question: kase, request: parsed, response,
    wallMs: performance.now() - started, control,
    sourceWitness: { path: kase.anchorFile!, contentHash: sourceHash,
      sourceCommit: inputs.preregistration.protocol!.sourceCommit },
    tokenWitness: await measureFairToolPayload(parsed, response) };
}

/** Restore before each question; mutations cannot leak into a later control. */
export async function prepareFrozenControl(tree: string, kase: FairCase, inputs: FrozenFairInputs) {
  const frozen = inputs.cases.find(candidate => candidate.id === kase.id);
  if (!frozen || hashCases([frozen]) !== hashCases([kase])) throw new Error('worker question differs from frozen case');
  await materializeFrozenControls(tree, inputs);
  const path = kase.anchorFile;
  if (!path || !(path in inputs.controlFiles)) return null;
  const configs = Object.keys(inputs.controlFiles).filter(file => dirname(file) === dirname(path) && file !== path);
  if (kase.configuration === 'unconfigured') for (const file of configs) await rm(join(tree, file));
  if (kase.sourceState === 'stale') {
    const before = inputs.controlFiles[path]!;
    const after = before.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }');
    if (after === before) throw new Error('frozen stale control has no caller mutation');
    await writeFile(join(tree, path), after);
  } else if (kase.sourceState === 'deleted') await rm(join(tree, path));
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  return { path, configuration: kase.configuration, sourceState: kase.sourceState,
    originalSourceHash: digest(inputs.controlFiles[path]!),
    currentSourceHash: kase.sourceState === 'deleted' ? null : digest(await readFile(join(tree, path), 'utf8')),
    configurationFiles: await Promise.all(configs.map(async file => ({ path: file,
      hash: kase.configuration === 'unconfigured' ? null : digest(await readFile(join(tree, file), 'utf8')) }))) };
}

// Importing CLI helpers must not require execFile from a caller's narrow mock.
// Reuse the lazy, typed wrapper pattern from git-batch; initialize on first run.
let runMemo: typeof execFile.__promisify__ | null = null;
const run = ((...args: unknown[]) =>
  Reflect.apply((runMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const BENCH = process.env.P017_BENCH ?? papercuspPath('bench', 'fair-comparison-2026-10');
const SNAPSHOT = join(BENCH, `snapshot-${FAIR_CORPUS_COMMIT.slice(0, 12)}`);
const VENDOR_HOME = process.env.P017_VENDOR_HOME ?? homedir();
const VENDOR_LSP = join(VENDOR_HOME, '.papercusp', 'vendor', 'lsp');
const deps: ArmDeps = { loadAvg1: () => loadavg()[0] ?? null };

export const FAIR_ARM_IDS = ['rg', 'lsp-query', 'no-third-party', 'gitnexus', 'codebase-memory', 'codegraph', 'trace-mcp', 'codegraphcontext'] as const;
export type FairArmId = (typeof FAIR_ARM_IDS)[number];

/** A file inside the operator-core tsconfig project: the lsp-query warm-up loads that one project. */
export const LSP_WARMUP_ANCHOR = 'packages/operator-core/lib/code-intelligence/contracts.ts';

const treeOf = (id: FairArmId): string => process.env.P017_TREE ?? join(BENCH, 'trees', id);
const homeOf = (id: FairArmId): string => process.env.P017_HOME ?? join(BENCH, 'homes', id);

/** Construct an arm. Construction starts nothing: engines spawn on index()/query(). */
export async function buildArm(id: FairArmId): Promise<FairArm> {
  const treeRoot = treeOf(id);
  const home = homeOf(id);
  switch (id) {
    case 'rg':
      return createRgFairArm(treeRoot, deps);
    case 'lsp-query': {
      const { createLspAdapterDoor } = await import('./fair-comparison-lsp-door');
      const ts = loadVendoredTypescript(VENDOR_LSP);
      return createLspQueryArm(
        {
          version: `typescript-language-server (vendored) / typescript ${ts.version}`,
          treeRoot,
          warmupAnchor: LSP_WARMUP_ANCHOR,
          loadAvg1: deps.loadAvg1,
        },
        createLspAdapterDoor(),
      );
    }
    case 'no-third-party':
      return createNoThirdPartyArm({ treeRoot, ts: loadVendoredTypescript(VENDOR_LSP), loadAvg1: deps.loadAvg1 });
    case 'gitnexus':
      return createGitnexusFairArm({ version: '1.6.9', bin: join(VENDOR_HOME, '.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus'), treeRoot, home, env: admitArm('gitnexus').env }, deps);
    case 'codebase-memory':
      return createCbmFairArm(
        {
          version: 'dev',
          bin: join(VENDOR_HOME, '.papercusp/bench/engine-comparison-2026-10/vendor/cbm/build/bench/codebase-memory-mcp'),
          treeRoot,
          home,
          cacheDir: join(home, 'cache'),
          env: admitArm('codebase-memory').env,
        },
        deps,
      );
    case 'codegraph':
      return createCodegraphArm({ version: '1.6.2', bin: join(BENCH, 'arms/codegraph/node_modules/.bin/codegraph'), treeRoot, home, env: admitArm('codegraph').env }, deps);
    case 'trace-mcp':
      return createTraceMcpArm({ version: '3.34.6', bin: join(BENCH, 'arms/trace-mcp/node_modules/.bin/trace-mcp'), treeRoot, home, env: admitArm('trace-mcp').env }, deps);
    case 'codegraphcontext':
      return createCgcArm({ version: '0.6.13', bin: join(BENCH, 'arms/cgc/.venv/bin/cgc'), treeRoot, home, env: admitArm('codegraphcontext').env }, deps);
  }
}

/** Logical files created after the source/dependency census. Missing reads stay unknown. */
export async function indexFileCensus(roots: readonly string[], baseline: ReadonlySet<string>): Promise<ArmResourceSample['indexFiles']> {
  const files: { path: string; bytes: number }[] = [];
  async function visit(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !baseline.has(path)) files.push({ path, bytes: statSync(path).size });
    }
  }
  try { for (const root of roots) await visit(root); }
  catch { return null; }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Point census using the managed cgroup walk and kernel PID identities. A second
 * walk detects population races; this does not observe forks between samples. */
export function fairProcessCensus(expected: { taskId: string; cgroupPath: string; rootPid: number; rootIdentity: string },
  deps: { fs?: CgroupFs; identity?: typeof readProcessIdentity; cgroup?: typeof readProcessCgroupPath } = {}):
  NonNullable<ArmResourceSample['processCensus']> {
  const unknown: string[] = [];
  const processes: { pid: number; identity: string | null; cgroupPath: string | null }[] = [];
  const result = () => ({ taskId: expected.taskId, cgroupPath: expected.cgroupPath, rootPid: expected.rootPid,
    processes, childProcesses: unknown.length ? null : processes.length - 1, unknown: [...new Set(unknown)] });
  const identity = deps.identity ?? readProcessIdentity;
  const cgroup = deps.cgroup ?? readProcessCgroupPath;
  const rootCurrent = identity(expected.rootPid);
  if (!expected.rootIdentity || rootCurrent !== expected.rootIdentity) unknown.push('worker-process-identity-mismatch');
  if (taskIdFromScopeUnit(basename(expected.cgroupPath)) !== expected.taskId ||
      cgroup(expected.rootPid) !== expected.cgroupPath) unknown.push('worker-task-cgroup-mismatch');
  // Refuse a broad/foreign cgroup before enumerating anyone else's processes.
  if (unknown.length) return result();
  const absolute = absCgroupDir(expected.cgroupPath);
  const raw: CgroupFs = deps.fs ?? {
    readFile: path => readFileSync(path, 'utf8'), readDir: path => readdirSync(path),
    isDir: path => statSync(path).isDirectory(),
  };
  const checked = <T>(path: string, read: () => T, fallback: T): T => {
    try { return read(); } catch { unknown.push(`unreadable-cgroup:${path}`); return fallback; }
  };
  const fs: CgroupFs = {
    readFile: path => {
      const value = checked(path, () => raw.readFile(path), null);
      if (value === null || value.split(/\s+/).filter(Boolean).some(pid => !/^[1-9]\d*$/.test(pid)))
        unknown.push(`unreadable-process-census:${path}`);
      return value;
    },
    readDir: path => checked(path, () => raw.readDir(path), []),
    isDir: path => {
      const directory = checked(path, () => raw.isDir(path), false);
      if (directory && relative(absolute, path).split('/').filter(Boolean).length > 32) {
        unknown.push(`cgroup-depth-unmeasured:${path}`); return false;
      }
      return directory;
    },
  };
  const pids = () => [...new Set(walkCgroupTree(absolute, fs).flatMap(group => group.pids))].sort((a, b) => a - b);
  const first = pids();
  if (!first.includes(expected.rootPid)) unknown.push('worker-missing-from-process-census');
  for (const pid of first) {
    const stamp = identity(pid), path = cgroup(pid);
    processes.push({ pid, identity: stamp, cgroupPath: path });
    if (!stamp) unknown.push(`process-identity-unreadable:${pid}`);
    if (!path || (path !== expected.cgroupPath && !path.startsWith(`${expected.cgroupPath}/`)))
      unknown.push(`process-outside-worker-cgroup:${pid}`);
  }
  if (JSON.stringify(first) !== JSON.stringify(pids())) unknown.push('cgroup-population-changed-during-census');
  for (const row of processes) {
    if (identity(row.pid) !== row.identity) unknown.push(`process-replaced-during-census:${row.pid}`);
    if (cgroup(row.pid) !== row.cgroupPath) unknown.push(`process-moved-during-census:${row.pid}`);
  }
  if (identity(expected.rootPid) !== expected.rootIdentity) unknown.push('worker-process-identity-mismatch');
  return result();
}

/** A dirty test parent can call an older committed child under test:file's
 * loader. Refuse that known RPC-contract mismatch before copying or spawning.
 * This is a precondition, not a claim that all transitive source is qualified. */
export async function verifyFairWorkerSource(readSource?:
  (path: string, version: 'working' | 'committed') => Promise<string>): Promise<void> {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const read = readSource ?? (async (path: string, version: 'working' | 'committed') => {
    if (version === 'working') return readFile(join(root, path), 'utf8');
    return (await run('git', ['-C', root, 'show', `HEAD:${path}`], { maxBuffer: 1 << 24 })).stdout;
  });
  for (const path of ['packages/operator-core/lib/code-intelligence/fair-comparison-cli.ts',
    'packages/operator-core/lib/code-intelligence/fair-comparison-run.ts']) {
    if (await read(path, 'working') !== await read(path, 'committed'))
      throw new Error(`fresh worker source differs from committed child: ${path}; wait for a containing commit and use lint:as-committed`);
  }
}

/** A non-index request to a fresh worker that has not replied by now is over every protocol budget. */
export const FAIR_WORKER_REQUEST_DEADLINE_MS = 120_000;
/** How long a worker may stay busy on an overrun request before the repetition fails loudly. */
export const FAIR_WORKER_DRAIN_CAP_MS = 15 * 60_000;
/** Slow graph backends may legitimately need more than four hours to build a frozen corpus. */
export const FAIR_WORKER_RUNTIME_MAX_SEC = 8 * 3600;

interface FairWorkerChannelIo {
  send(line: string, sent: (error?: Error | null) => void): void;
  isLive(): boolean;
  deadlineMs(method: string): number;
  drainCapMs: number;
  now(): number;
}

/**
 * The parent side of the line protocol to one fresh worker. The worker serves one
 * request at a time, in order. So a query that overruns its deadline still occupies
 * the worker after the parent stops waiting for it. Two consequences follow:
 *  - the overrun case is SCORED `timed-out` (an outcome the protocol keeps apart from
 *    wrong answers), not thrown as an error that discards the arm's whole run; and
 *  - the next request is not sent until the late reply arrives, so the next case is
 *    not charged its predecessor's overrun. A worker still busy after `drainCapMs`
 *    fails the repetition loudly instead of timing out every remaining case.
 */
export function createFairWorkerChannel(io: FairWorkerChannelIo) {
  let sequence = 0;
  let late: Promise<void> | null = null;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const failAll = (error: Error) => {
    const waiters = [...pending.values()]; pending.clear();
    for (const waiter of waiters) waiter.reject(error);
  };
  const receive = (line: string) => {
    if (!line.startsWith('FAIR_WORKER_REPLY=')) return;
    try {
      const reply = JSON.parse(line.slice('FAIR_WORKER_REPLY='.length)) as { id: number; result?: unknown; error?: string };
      const waiter = pending.get(reply.id); pending.delete(reply.id);
      if (reply.error) waiter?.reject(new Error(reply.error)); else waiter?.resolve(reply.result);
    } catch (error) { failAll(new Error(String(error))); }
  };
  const whenFree = async () => {
    const waiting = late;
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const freed = await Promise.race([waiting.then(() => true),
        new Promise<boolean>(done => { timer = setTimeout(() => done(false), io.drainCapMs); })]);
      if (!freed) throw new Error(`fresh worker still busy ${io.drainCapMs}ms after a request deadline`);
    } finally { clearTimeout(timer); }
    if (late === waiting) late = null;
  };
  const send = <T>(method: string, kase?: FairCase): Promise<T> => new Promise((done, reject) => {
    if (!io.isLive()) { reject(new Error('fresh worker is no longer live')); return; }
    const requestId = ++sequence;
    const timer = setTimeout(() => {
      // Keep a sink for the eventual reply: its arrival is what frees the worker.
      late = new Promise<void>(free => { pending.set(requestId, { resolve: () => free(), reject: () => free() }); });
      reject(new Error(`fresh worker ${method} deadline`));
    }, io.deadlineMs(method));
    pending.set(requestId, { resolve: value => { clearTimeout(timer); done(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
    io.send(`${JSON.stringify({ id: requestId, method, kase })}\n`, error => {
      if (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
    });
  });
  const rpc = async <T>(method: string, kase?: FairCase): Promise<T> => { await whenFree(); return send<T>(method, kase); };
  const query = async (kase: FairCase): Promise<ArmAnswer> => {
    await whenFree();
    const started = io.now();
    try { return await send<ArmAnswer>('query', kase); } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail !== 'fresh worker query deadline') throw error;
      return { caseId: kase.id, status: 'timed-out', sites: [], latencyMs: io.now() - started, detail };
    }
  };
  return { receive, failAll, rpc, query };
}

/** One managed worker per repetition; reuse the existing arm adapters and task metrics. */
export async function freshFactory(id: FairArmId, inputs: FrozenFairInputs, frozenPath: string): Promise<FairArmFactory> {
  await verifyFairWorkerSource();
  const sourceCommit = inputs.preregistration.protocol!.sourceCommit;
  const snapshot = join(BENCH, `snapshot-${sourceCommit.slice(0, 12)}`);
  await verifyFrozenSource(snapshot, inputs);
  const admitted = await buildArm(id);
  return { capabilities: admitted.capabilities, unavailable: admitted.unavailable, async create(rep) {
    const { managedSpawn } = await import('../task-manager/managed-spawn');
    const { absCgroupDir, readProcessCgroupPath, sampleCgroup } = await import('../task-manager/cgroup-read');
    const { deriveUserManagerRoot, scopeCgroupRelPath } = await import('../task-manager/types');
    await mkdir(join(BENCH, 'repetitions'), { recursive: true });
    const owned = await mkdtemp(join(BENCH, 'repetitions', `${id}-${rep}-`));
    const treeRoot = join(owned, 'tree'), home = join(owned, 'home');
    let child: import('node:child_process').ChildProcess | null = null;
    let exited: Promise<void> | null = null;
    let taskId: string | null = null;
    let cgroupPath: string | null = null;
    let scopeUnit: string | null = null;
    const stop = async () => {
      if (taskId) {
        const { killScopeUnit, killTask } = await import('../task-manager/control');
        const outcome = await killTask(taskId, { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
        if (!outcome.ok && outcome.error !== 'already_gone') {
          // A terminal confined row may be refused as not_live even after its
          // cgroup has emptied. Confirm that kernel state instead of reading a
          // refusal as either unconditional success or a surviving process.
          const scope = outcome.error === 'not_live' && scopeUnit
            ? await killScopeUnit(scopeUnit, { escalateAfterMs: 500 }) : null;
          if (!scope || (!scope.ok && scope.error !== 'already_gone'))
            throw new Error(`fresh worker task cleanup refused (${outcome.error}); isolated files retained`);
        }
      }
      if (exited) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const drained = await Promise.race([exited.then(() => true),
            new Promise<boolean>(done => { timer = setTimeout(() => done(false), 10_000); })]);
          if (!drained) {
            // managedSpawn's child is the transient systemd-run client. Under load it
            // can miss/withhold its `close` event even after killTask has reaped the
            // confined payload. Prove the authoritative scope is gone before deleting
            // the worker's private files instead of discarding an otherwise complete run.
            const scope = scopeUnit ? await killScopeUnit(scopeUnit, { escalateAfterMs: 500 }) : null;
            if (!scope || (!scope.ok && scope.error !== 'already_gone'))
              throw new Error('fresh worker task failed to drain; isolated files retained');
          }
        } finally { clearTimeout(timer); }
      }
      await rm(owned, { recursive: true, force: true });
    };
    try {
      // Copy-on-write rather than hardlinks: freshness controls must never mutate
      // the frozen donor when they replace or delete original source bytes.
      await run('cp', ['-a', '--reflink=auto', snapshot, treeRoot]);
      await verifyFrozenSource(treeRoot, inputs);
      await mkdir(home);
      await linkWorkspaces(treeRoot);
      await materializeFrozenControls(treeRoot, inputs);
      const before = await indexFileCensus([treeRoot, home], new Set());
      if (!before) throw new Error('fresh repetition source/dependency census unreadable');
      const baseline = new Set(before.map(file => file.path));
      const workerArgv = ['--import', 'tsx', fileURLToPath(import.meta.url), 'worker', '--arm', id];
      const launched = await managedSpawn(process.execPath, workerArgv,
        { class: 'test-run', title: `fair comparison ${id} repetition ${rep}`,
          argv: [process.execPath, ...workerArgv],
          launchedBy: process.env.PAPERCUSP_SID ?? 'human', workItemId: 'WI-10007889',
          runtimeMaxSec: FAIR_WORKER_RUNTIME_MAX_SEC },
        { requireRegistration: true, spawnOptions: { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'],
          env: { ...process.env, P017_BENCH: BENCH, P017_TREE: treeRoot, P017_HOME: home,
            P017_VENDOR_HOME: VENDOR_HOME, P017_FROZEN: resolve(frozenPath) } } });
      child = launched.child;
      taskId = launched.taskId;
      scopeUnit = launched.scopeUnit;
      exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
        : new Promise(done => child!.once('close', () => done()));
      if (!launched.confined || !launched.scopeUnit) throw new Error('fresh worker task cgroup unavailable');
      cgroupPath = scopeCgroupRelPath(deriveUserManagerRoot(readProcessCgroupPath(process.pid)), 'test-run', launched.scopeUnit);
      let buffer = '';
      const channel = createFairWorkerChannel({
        send: (line, sent) => { child!.stdin!.write(line, sent); },
        isLive: () => child!.exitCode === null && child!.signalCode === null && !child!.stdin!.destroyed,
        deadlineMs: method => method === 'index' ? 4 * 3600_000 : FAIR_WORKER_REQUEST_DEADLINE_MS,
        drainCapMs: FAIR_WORKER_DRAIN_CAP_MS,
        now: () => performance.now(),
      });
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          channel.receive(line);
        }
      });
      child.once('close', () => channel.failAll(new Error('fresh worker exited')));
      child.once('error', error => channel.failAll(error));
      const rpc = channel.rpc;
      const close = async () => {
        try { await rpc('close'); } finally {
          child!.stdin!.end();
          await stop();
        }
      };
      const confinedPath = cgroupPath;
      // child.pid is systemd-run's client, not the confined payload. Obtain the
      // payload's identity through the existing worker RPC before any census.
      const payload = await rpc<{ pid: number; identity: string }>('identity');
      const censusIdentity = { taskId: launched.taskId, cgroupPath: confinedPath,
        rootPid: payload.pid, rootIdentity: payload.identity };
      let observedChildProcessesMax: number | null = null;
      return { identity: { taskId: launched.taskId, cgroupPath: confinedPath, treeRoot, home, sourceCommit,
        runtimeVersion: admitted.capabilities.version },
      arm: { capabilities: admitted.capabilities, unavailable: null,
        index: () => rpc('index'), query: kase => channel.query(kase), close },
      nativeGraphQuery: kase => rpc<Awaited<ReturnType<typeof replayFrozenGraphTask>>>('native-graph', kase),
      async sampleResources(_stage: ResourceStage) {
        const sample = sampleCgroup(absCgroupDir(confinedPath));
        const processCensus = fairProcessCensus(censusIdentity);
        if (processCensus.childProcesses !== null)
          observedChildProcessesMax = Math.max(observedChildProcessesMax ?? 0, processCensus.childProcesses);
        const indexFiles = await indexFileCensus([treeRoot, home], baseline);
        const unknown: string[] = [...processCensus.unknown, 'descendant-process-lifetime-peak-not-measured'];
        if (sample.memoryBytes === null) unknown.push('memory.current unreadable');
        if (sample.peakMemoryBytes === null) unknown.push('memory.peak unreadable');
        if (indexFiles === null) unknown.push('index census unreadable');
        // LSP adapters may start independently managed server tasks outside this
        // scope. A task-only counter must not certify those costs as included.
        if (id === 'lsp-query') unknown.push('language-server-task-costs-not-in-worker-scope');
        unknown.push('native-tool-seam-and-configuration-invalidation-not-verified');
        return { sampledAt: new Date().toISOString(), memoryCurrentBytes: sample.memoryBytes,
          memoryPeakBytes: sample.peakMemoryBytes, peakChildProcesses: null,
          processCensus, observedChildProcessesMax, indexFiles, unknown };
      } };
    } catch (error) {
      await stop();
      throw error;
    }
  } };
}

async function worker(id: FairArmId): Promise<void> {
  const { createInterface } = await import('node:readline');
  if (!process.env.P017_FROZEN) throw new Error('protocol worker requires frozen input custody');
  const inputs = validateFrozenInputs(JSON.parse(await readFile(process.env.P017_FROZEN, 'utf8')) as FrozenFairInputs);
  const arm = await buildArm(id);
  let indexed = false;
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as { id: number; method: string; kase?: FairCase };
    try {
      if ((request.method === 'query' || request.method === 'native-graph') && !indexed)
        throw new Error('worker query before frozen source indexing');
      const control = request.method === 'query' ? await prepareFrozenControl(treeOf(id), request.kase!, inputs) : null;
      const result = request.method === 'native-graph' ? await replayFrozenGraphTask(treeOf(id), request.kase!, inputs) :
        request.method === 'identity' ? { pid: process.pid, identity: readProcessIdentity(process.pid) } :
        request.method === 'index' ? await arm.index() : request.method === 'query' ?
        { ...await arm.query(request.kase!), control }
        : request.method === 'close' ? await arm.close?.() ?? null : (() => { throw new Error('unknown worker method'); })();
      if (request.method === 'index') indexed = (result as { ok?: boolean }).ok === true;
      process.stdout.write(`FAIR_WORKER_REPLY=${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === 'close') break;
    } catch (error) { process.stdout.write(`FAIR_WORKER_REPLY=${JSON.stringify({ id: request.id, error: String(error) })}\n`); }
  }
}

/** Reuse the maintained npm workspace resolver, including negated patterns. */
export async function workspaceDirs(root: string, patterns: readonly string[]): Promise<string[]> {
  const resolverUrl = new URL('../../../../scripts/assert-workspace-links.mjs', import.meta.url).href;
  const { expandWorkspaces } = await import(resolverUrl) as {
    expandWorkspaces(patterns: readonly string[], root: string): string[];
  };
  return expandWorkspaces(patterns, root);
}

/** node_modules/<name> -> workspace dir links, exactly what npm install creates for workspaces. */
async function linkWorkspaces(tree: string): Promise<number> {
  const pkg = JSON.parse(await readFile(join(tree, 'package.json'), 'utf8')) as { workspaces?: string[] };
  let n = 0;
  for (const dir of await workspaceDirs(tree, pkg.workspaces ?? [])) {
    const { name } = JSON.parse(await readFile(join(tree, dir, 'package.json'), 'utf8')) as { name?: string };
    if (!name) continue;
    const link = join(tree, 'node_modules', name);
    if (existsSync(link)) continue;
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), join(tree, dir)), link);
    n += 1;
  }
  return n;
}

/** The arm's own copy of the frozen snapshot: hardlinks, workspace links, one git commit. */
async function prepareTree(id: FairArmId): Promise<void> {
  const tree = treeOf(id);
  await mkdir(homeOf(id), { recursive: true });
  if (existsSync(join(tree, '.p017-ready'))) return;
  if (!existsSync(SNAPSHOT)) throw new Error(`frozen snapshot missing: ${SNAPSHOT}`);
  await mkdir(dirname(tree), { recursive: true });
  if (!existsSync(tree)) await run('cp', ['-al', SNAPSHOT, tree], { maxBuffer: 1 << 26 });
  const links = await linkWorkspaces(tree);
  const git = (args: string[]) => run('git', ['-c', 'user.name=p017', '-c', 'user.email=p017@local', '-c', 'commit.gpgsign=false', ...args], { cwd: tree, maxBuffer: 1 << 26 });
  if (!existsSync(join(tree, '.git'))) {
    await git(['init', '-q']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', `P-017 snapshot ${FAIR_CORPUS_COMMIT}`]);
  }
  await writeFile(join(tree, '.p017-ready'), JSON.stringify({ commit: FAIR_CORPUS_COMMIT, workspaceLinks: links, at: new Date().toISOString() }));
}

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const cases = FAIR_CORPUS.map((e) => e.kase);
const optionalArg = (name: string): string | undefined => process.argv.includes(`--${name}`) ? arg(name) : undefined;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'worker') { await worker(arg('arm') as FairArmId); return; }
  const out = arg('out');
  await mkdir(out, { recursive: true });
  if (cmd === 'prereg') {
    if (optionalArg('frozen')) throw new Error('the supplied edition is already frozen; use run --frozen, never re-register it');
    if (existsSync(join(out, 'prereg.json'))) throw new Error(`${out}/prereg.json exists: a preregistration is never rewritten`);
    const arms: ArmCapabilities[] = [];
    for (const id of FAIR_ARM_IDS) arms.push((await buildArm(id)).capabilities);
    const prereg = preregister({ cases, keys: initialKeys(FAIR_CORPUS), arms, reps: Number(arg('reps', '3')), seed: Number(arg('seed', '20261006')) });
    await writeFile(join(out, 'prereg.json'), JSON.stringify(prereg, null, 2));
    console.log(`prereg ${prereg.hash} cases=${prereg.corpusIds.length} arms=${arms.length} reps=${prereg.reps}`);
  } else if (cmd === 'run') {
    const id = arg('arm') as FairArmId;
    if (!FAIR_ARM_IDS.includes(id)) throw new Error(`unknown arm ${id}; one of ${FAIR_ARM_IDS.join(', ')}`);
    const frozenPath = optionalArg('frozen');
    const inputs = await loadFairInputs(out, frozenPath);
    const prereg = inputs.preregistration;
    // Before prepareTree: a concurrent run of this arm shares its tree and HOME.
    const lock = await acquireArmRunLock(out, id);
    let result: ArmRun;
    try {
      if (prereg.protocol) result = await runArm(await freshFactory(id, inputs, frozenPath!), inputs.cases, prereg);
      else { await prepareTree(id); result = await runArm(await buildArm(id), inputs.cases, prereg); }
      await writeFile(join(out, `${id}.run.json`), JSON.stringify(result, null, 2));
    } finally {
      await lock.release();
    }
    const answered = result.reps.flatMap((r) => r.answers).filter((a) => a.status === 'answered').length;
    console.log(`${id} index ok=${result.index?.ok} wallMs=${Math.round(result.index?.wallMs ?? 0)} reps=${result.reps.length} answered=${answered}`);
  } else if (cmd === 'score') {
    const inputs = await loadFairInputs(out, optionalArg('frozen'));
    const prereg = inputs.preregistration;
    const runs: ArmRun[] = [];
    for (const f of (await readdir(out)).filter((n) => n.endsWith('.run.json')).sort()) runs.push(await readJson<ArmRun>(join(out, f)));
    const verdicts = existsSync(join(out, 'verdicts.json')) ? await readJson<Record<string, never[]>>(join(out, 'verdicts.json')) : {};
    const scored = scoreRuns(runs, inputs.cases, inputs.keys, verdicts, prereg);
    await writeFile(join(out, 'pending.json'), JSON.stringify(scored.pending, null, 2));
    await writeFile(join(out, 'report.json'), JSON.stringify({ prereg: prereg.hash, aggregates: scored.aggregates, decision: scored.decision, keys: scored.keys }, null, 2));
    console.log(`score runs=${runs.length} pendingSites=${scored.pending.reduce((n, p) => n + p.sites.length, 0)} decision=${scored.decision.kind}`);
  } else if (cmd === 'adjudicate') {
    const inputs = await loadFairInputs(out, optionalArg('frozen'));
    if (inputs.preregistration.protocol) throw new Error('protocol adjudication requires review of the frozen multilingual sites; the legacy TypeScript-only adjudicator cannot certify it');
    const { autoAdjudicatePending, createAdjudicator } = await import('./fair-comparison-adjudicate');
    const { openTsTree } = await import('./fair-comparison-first-party');
    const pending = await readJson<PendingSites[]>(join(out, 'pending.json'));
    const existing = existsSync(join(out, 'verdicts.json')) ? await readJson<Record<string, AdjudicationVerdict[]>>(join(out, 'verdicts.json')) : {};
    // The no-third-party arm's tree: the frozen snapshot plus the workspace node_modules links,
    // so cross-package imports resolve the way they do in a real checkout.
    await prepareTree('no-third-party');
    const t0 = Date.now();
    const tree = openTsTree(loadVendoredTypescript(VENDOR_LSP), treeOf('no-third-party'));
    const result = autoAdjudicatePending(createAdjudicator(tree), inputs.cases, inputs.keys, pending, existing);
    await writeFile(join(out, 'verdicts.json'), JSON.stringify(result.verdicts, null, 2));
    await writeFile(join(out, 'adjudication-undecided.json'), JSON.stringify(result.undecided, null, 2));
    const pooled = pending.reduce((n, p) => n + p.sites.length, 0);
    console.log(`adjudicate pooled=${pooled} acceptedVerdicts=${result.accepted} undecided=${result.undecided.length} files=${tree.fileCount} wallMs=${Date.now() - t0}`);
  } else {
    throw new Error('usage: fair-comparison-cli.ts prereg|run|score|adjudicate --out <dir> [--arm <id>] [--reps N] [--seed N]');
  }
}

if (process.argv[1] && /fair-comparison-cli\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
