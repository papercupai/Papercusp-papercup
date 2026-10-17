/**
 * Record workload-corpus sessions (plan agent-capacity-and-cost-gcp-2026-09-30, P-002).
 *
 *   npx tsx scripts/agent-capacity/record-session.ts --cli claude|codex --tasks all|<id,id> \
 *     [--parallel 3] [--out ~/.cache/agent-capacity/corpus] [--upstream http://127.0.0.1:8788] \
 *     [--claude-model sonnet] [--isolation systemd|none] [--keep-work] [--tasks-file <tasks.json>]
 *     [--codex-model <model> --codex-effort low|medium|high]
 *     [--max-model-requests <batch-wide positive integer; requires explicit Codex selection>]
 *     [--max-request-bytes <positive integer; requires --max-model-requests>]
 *     [--max-model-usd <USD, six decimal places max> --max-provider-attempts <integer>
 *      --provider-account <id> --provider-credential-sha256 <digest> --provider-target <exact HTTPS URL>]
 * The credential digest binds the complete outgoing Authorization header, including its Bearer prefix.
 *
 * For each task: copy the prepared (dependencies-installed) checkout of its pinned repo,
 * start a recording proxy in front of the local inference gateway, run the real CLI
 * headless against it with a fresh config dir (no user hooks/MCP — a customer-shaped
 * agent), and write <out>/<sessionId>/{meta.json, exchanges.jsonl, cli.jsonl, stderr.log,
 * diff.patch}. Prepared checkouts live at ~/.cache/agent-capacity/prepared/<repo> (see the
 * repo `setup` commands in corpus/tasks.json).
 *
 * With `--isolation systemd` (the default) each session runs as its own transient user unit in
 * `caprec.slice`, and meta.json carries the session's `memPeakBytes` and `cpuUsec`, measured
 * by the same wrapper the replay driver uses (session-process.ts). That is what lets P-004 set
 * a real session's footprint beside its replay's. Sample `caprec.slice` with
 * `vm/sample-footprint.py` for the concurrent time series.
 *
 * Nothing here blocks the event loop: the recording proxy for every parallel session shares
 * it, so checkouts are copied with a spawned `cp` and git runs asynchronously.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertHostAdmission, capacityCacheRoot } from './host-admission';
import { recordingRequestLimit, startRecordProxy, type RecordingRequestLimit } from './record-proxy';
import { recordingBudgetFromArgv, recordingBudgetJournal, startRecordingBudgetGateway } from './record-budget';
import { copyTree, parseCgroupStats, removeTree, sessionSpawn, type Isolation } from './session-process';

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
/** The slice real (recorded) sessions run in, kept apart from replayed ones in capdrv.slice. */
export const RECORD_SLICE = 'caprec.slice';

export type Cli = 'claude' | 'codex';
export type Profile = 'light' | 'typical' | 'heavy';
export interface CorpusTask { id: string; repo: string; profile: Profile; prompt: string }
export interface Corpus {
  version: number;
  suffix: string;
  timeoutSec: Record<Profile, number>;
  repos: Record<string, { url: string; sha: string; kind: string; setup: string[] }>;
  tasks: CorpusTask[];
}

export const CORPUS_FILE = path.join(__dirname, 'corpus', 'tasks.json');
export const OWNER_HEADER_VALUE = 'agent-capacity-corpus';
const CACHE = capacityCacheRoot(__dirname);

/**
 * The task file a CLI run reads: `--tasks-file <path>` when given, else the shipped corpus. P-019
 * runs real Papercusp backlog items from its own task file through the same recorder and
 * replayer. (Not `--corpus`: load-driver.ts already uses that for the recordings directory.)
 */
export function corpusFileFromArgv(argv: readonly string[]): string {
  const i = argv.indexOf('--tasks-file');
  if (i < 0) return CORPUS_FILE;
  const file = argv[i + 1];
  if (!file || file.startsWith('--')) throw new Error('--tasks-file needs a path');
  return path.resolve(file);
}

export function loadCorpus(file = CORPUS_FILE): Corpus {
  return JSON.parse(readFileSync(file, 'utf8')) as Corpus;
}

/** The caller's env minus every agent/session variable, so the recorded CLI is customer-shaped. */
export function cleanEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/^(PAPERCUSP_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|MCP_|PSU_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export function claudeEnv(base: NodeJS.ProcessEnv, proxyUrl: string, configDir: string): Record<string, string> {
  return {
    ...cleanEnv(base),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_AUTH_TOKEN: 'papercusp-gateway',
    ANTHROPIC_CUSTOM_HEADERS: `x-papercusp-owner: ${OWNER_HEADER_VALUE}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

export interface CodexSelection { model: string; effort: 'low' | 'medium' | 'high' }

function validateCodexSelection(selection: CodexSelection): CodexSelection {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(selection.model) ||
      !['low', 'medium', 'high'].includes(selection.effort)) {
    throw new Error('Codex selection needs a model id and effort low|medium|high');
  }
  return { model: selection.model, effort: selection.effort };
}

/** No selection means unknown defaults; never backfill a historical binding. */
export function codexSelectionFromArgv(argv: readonly string[]): CodexSelection | undefined {
  const modelIndex = argv.indexOf('--codex-model');
  const effortIndex = argv.indexOf('--codex-effort');
  if (modelIndex < 0 && effortIndex < 0) return undefined;
  const model = modelIndex < 0 ? undefined : argv[modelIndex + 1];
  const effort = effortIndex < 0 ? undefined : argv[effortIndex + 1];
  if (!model || model.startsWith('--') || !effort || effort.startsWith('--')) {
    throw new Error('--codex-model and --codex-effort must both have values');
  }
  return validateCodexSelection({ model, effort: effort as CodexSelection['effort'] });
}

export function recordingLimitFromArgv(argv: readonly string[], cli: Cli, selection?: CodexSelection): RecordingRequestLimit | undefined {
  const index = argv.indexOf('--max-model-requests');
  const bytesIndex = argv.indexOf('--max-request-bytes');
  if (index < 0) {
    if (bytesIndex >= 0) throw new Error('--max-request-bytes requires --max-model-requests');
    return undefined;
  }
  const raw = argv[index + 1];
  if (cli !== 'codex' || !selection || !raw || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error('--max-model-requests requires explicit Codex model/effort and a positive integer');
  }
  const bytes = bytesIndex < 0 ? undefined : argv[bytesIndex + 1];
  if (bytesIndex >= 0 && (!bytes || !/^[1-9][0-9]*$/.test(bytes))) {
    throw new Error('--max-request-bytes requires a positive integer');
  }
  return recordingRequestLimit(selection, Number(raw), bytes === undefined ? undefined : Number(bytes));
}

/** config.toml for a fresh CODEX_HOME whose only model provider is the recording proxy. */
export function codexConfigToml(proxyUrl: string, selection?: CodexSelection): string {
  const chosen = selection === undefined ? undefined : validateCodexSelection(selection);
  return [
    ...(chosen ? [`model = ${JSON.stringify(chosen.model)}`, `model_reasoning_effort = ${JSON.stringify(chosen.effort)}`] : []),
    'model_provider = "capture"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.capture]',
    'name = "capture"',
    `base_url = "${proxyUrl}/v1"`,
    'wire_api = "responses"',
    `http_headers = { originator = "codex_cli_rs", "x-papercusp-owner" = "${OWNER_HEADER_VALUE}" }`,
    '',
  ].join('\n');
}

/** The exact prompt a task is run with — replay must send the identical text. */
export function promptFor(corpus: Corpus, task: CorpusTask): string {
  return `${task.prompt}\n\n${corpus.suffix}`;
}

export function cliArgs(cli: Cli, prompt: string, workDir: string, claudeModel: string): string[] {
  if (cli === 'claude') {
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', claudeModel];
  }
  // codex-cli 0.159 removed --full-auto; exec never prompts, and workspace-write is the sandbox it implied.
  return ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', workDir, prompt];
}

/** Count tool calls by name from the CLI's own JSON event stream (claude stream-json / codex exec --json). */
export function summarizeToolCalls(cli: Cli, jsonl: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (cli === 'claude') {
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) if (block?.type === 'tool_use') bump(String(block.name));
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type !== 'agent_message' && ev.item.type !== 'reasoning') {
      bump(String(ev.item.type));
    }
  }
  return counts;
}

/**
 * How many tool calls finished, and how many of them failed, per the CLI's own JSON event
 * stream: claude `tool_result` blocks (`is_error`), codex completed items (`status: failed`).
 * A replay whose counts differ from its recording's ran different tool work than the recording
 * did, however exactly its model requests matched.
 */
export function summarizeToolOutcomes(cli: Cli, jsonl: string): { results: number; errors: number } {
  let results = 0;
  let errors = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (cli === 'claude') {
      if (ev.type !== 'user' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) {
        if (block?.type !== 'tool_result') continue;
        results++;
        if (block.is_error === true) errors++;
      }
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type !== 'agent_message' && ev.item.type !== 'reasoning') {
      results++;
      if (ev.item.status === 'failed') errors++;
    }
  }
  return { results, errors };
}

/** Where `recordSession` runs a session's checkout: tool calls in its recording name this path. */
export function recordedWorkDir(sessionId: string, cacheDir = CACHE): string {
  return path.join(cacheDir, 'work', sessionId);
}

/**
 * Everything the session changed relative to the pinned sha: committed work, uncommitted edits
 * and new files, with submodule changes inlined. A plain `git diff` (worktree vs index) is empty
 * when the agent commits its fix, which the P-019 real-work tasks ask it to do. Stages the
 * throwaway session checkout to pick up untracked files; returns '' if git fails.
 */
export async function sessionDiff(workDir: string, baseSha: string): Promise<string> {
  const opts = { encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
  try {
    await execFileAsync('git', ['-C', workDir, 'add', '-A'], opts);
    return (await execFileAsync('git', ['-C', workDir, 'diff', '--cached', '--submodule=diff', baseSha], opts)).stdout;
  } catch {
    return '';
  }
}

/**
 * `<command> --version` resolved on `PATH` — the PATH the session itself ran under, so the
 * recorded version is the build the session used (the parent's PATH can resolve a different
 * one: measured 2026-10-01, the systemd user PATH found codex 0.157.1 before the pinned 0.159.2).
 */
async function versionOn(command: string, PATH: string | undefined, onError: string): Promise<string> {
  try {
    const env = PATH === undefined ? process.env : { ...process.env, PATH };
    return (await execFileAsync(command, ['--version'], { encoding: 'utf8', timeout: 20_000, env })).stdout.trim();
  } catch {
    return onError;
  }
}

export interface SessionMeta {
  sessionId: string;
  corpusVersion: number;
  task: CorpusTask;
  repo: { name: string; sha: string; kind: string };
  cli: Cli;
  cliVersion: string;
  claudeModel: string | null;
  /** Requested settings, not proof of the model served; inspect exchanges for that. */
  codexSelection?: CodexSelection;
  /** Snapshot of the batch counter at session completion, not a billed cost. */
  recordingLimit?: ReturnType<RecordingRequestLimit['snapshot']>;
  startedAt: string;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  exchanges: number;
  toolCalls: Record<string, number>;
  diffBytes: number;
  /**
   * The absolute checkout path the session ran in. Its tool calls name files under it, so a
   * replay rewrites it to the replay's own checkout. Absent on recordings made before it was
   * stored; those ran in `recordedWorkDir(sessionId)` on the recording host.
   */
  workDir?: string;
  /** How the session ran; absent on recordings made before per-session accounting existed. */
  isolation?: Isolation;
  /** The session cgroup's memory.peak (CLI plus every tool it spawned); null without systemd isolation. */
  memPeakBytes?: number | null;
  /** The session cgroup's cpu.stat usage_usec; null without systemd isolation. */
  cpuUsec?: number | null;
  /**
   * The command environment the session resolved tools on: its PATH, and `node --version` on
   * that PATH (null when no node was found). Which tools a PATH exposes changes what a
   * recorded `which`/`npx`/`corepack` call returns, so a replay that resolves on a different
   * PATH can take another branch. Absent on recordings made before it was stored.
   */
  env?: { path: string | null; node: string | null };
}

export async function recordSession(opts: {
  corpus: Corpus;
  task: CorpusTask;
  cli: Cli;
  outDir: string;
  upstream: string;
  claudeModel: string;
  codexSelection?: CodexSelection;
  requestLimit?: RecordingRequestLimit;
  upstreamHeaders?: Readonly<Record<string, string>>;
  keepWork: boolean;
  /** Default `systemd`: per-session cgroup accounting in caprec.slice. */
  isolation?: Isolation;
}): Promise<SessionMeta> {
  const { corpus, task, cli } = opts;
  const codexSelection = cli === 'codex' && opts.codexSelection !== undefined
    ? validateCodexSelection(opts.codexSelection) : undefined;
  const isolation = opts.isolation ?? 'systemd';
  const repo = corpus.repos[task.repo];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const sessionId = `${cli}-${task.id}-${stamp}`;
  const sessionDir = path.join(opts.outDir, sessionId);
  const workDir = recordedWorkDir(sessionId);
  const prepared = path.join(CACHE, 'prepared', task.repo);
  if (!existsSync(prepared)) throw new Error(`prepared checkout missing: ${prepared}`);
  const head = (await execFileAsync('git', ['-C', prepared, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  if (head !== repo.sha) throw new Error(`prepared ${task.repo} is at ${head}, corpus pins ${repo.sha}`);
  mkdirSync(sessionDir, { recursive: true });
  await copyTree(prepared, workDir);

  const proxy = await startRecordProxy({ upstream: opts.upstream, outFile: path.join(sessionDir, 'exchanges.jsonl'), sessionId,
    requestLimit: opts.requestLimit, upstreamHeaders: opts.upstreamHeaders });
  const home = path.join(CACHE, 'cli-home', sessionId);
  mkdirSync(home, { recursive: true });
  let env: Record<string, string>;
  if (cli === 'claude') {
    env = claudeEnv(process.env, proxy.url, home);
  } else {
    writeFileSync(path.join(home, 'config.toml'), codexConfigToml(proxy.url, codexSelection));
    env = { ...cleanEnv(process.env), CODEX_HOME: home };
  }
  const prompt = promptFor(corpus, task);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const cliOut = createWriteStream(path.join(sessionDir, 'cli.jsonl'));
  const cliErr = createWriteStream(path.join(sessionDir, 'stderr.log'));
  const statsFile = path.join(sessionDir, 'cgroup.stats');
  const argv = [cli, ...cliArgs(cli, prompt, workDir, opts.claudeModel)];
  const s = sessionSpawn(isolation, `caprec-${sessionId}`, workDir, env, statsFile, argv, process.env, RECORD_SLICE);
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(s.cmd, s.args, { cwd: workDir, env: s.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(cliOut);
    child.stderr.pipe(cliErr);
    const timer = setTimeout(() => {
      timedOut = true;
      if (s.killArgs) spawn('systemctl', s.killArgs, { stdio: 'ignore' });
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 10_000).unref();
    }, corpus.timeoutSec[task.profile] * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const wallMs = Date.now() - t0;
  await proxy.close();
  await new Promise<void>((r) => cliOut.end(r));
  await new Promise<void>((r) => cliErr.end(r));

  const diff = await sessionDiff(workDir, repo.sha);
  writeFileSync(path.join(sessionDir, 'diff.patch'), diff);
  const stats = existsSync(statsFile) ? parseCgroupStats(readFileSync(statsFile, 'utf8')) : { memPeakBytes: null, cpuUsec: null };
  const meta: SessionMeta = {
    sessionId,
    corpusVersion: corpus.version,
    task,
    repo: { name: task.repo, sha: repo.sha, kind: repo.kind },
    cli,
    cliVersion: await versionOn(cli, env.PATH, 'unknown'),
    claudeModel: cli === 'claude' ? opts.claudeModel : null,
    ...(codexSelection ? { codexSelection } : {}),
    ...(opts.requestLimit ? { recordingLimit: opts.requestLimit.snapshot() } : {}),
    startedAt,
    wallMs,
    exitCode,
    timedOut,
    exchanges: proxy.count(),
    toolCalls: summarizeToolCalls(cli, readFileSync(path.join(sessionDir, 'cli.jsonl'), 'utf8')),
    diffBytes: Buffer.byteLength(diff),
    workDir,
    isolation,
    ...stats,
    env: { path: env.PATH ?? null, node: (await versionOn('node', env.PATH, '')) || null },
  };
  writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  if (!opts.keepWork) await removeTree(workDir);
  await removeTree(home);
  return meta;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  assertHostAdmission(__dirname);
  const corpus = loadCorpus(corpusFileFromArgv(process.argv));
  const cli = arg('cli') as Cli;
  if (cli !== 'claude' && cli !== 'codex') throw new Error('--cli claude|codex required');
  const codexSelection = codexSelectionFromArgv(process.argv);
  if (cli !== 'codex' && codexSelection) throw new Error('--codex-model/--codex-effort require --cli codex');
  const requestLimit = recordingLimitFromArgv(process.argv, cli, codexSelection);
  const budgetConfig = recordingBudgetFromArgv(process.argv, codexSelection);
  if (budgetConfig && (cli !== 'codex' || !requestLimit || process.argv.includes('--upstream'))) {
    throw new Error('Provider budget requires bounded Codex recording and its private gateway (no --upstream)');
  }
  const sel = arg('tasks', 'all')!;
  const tasks = sel === 'all' ? corpus.tasks : corpus.tasks.filter((t) => sel.split(',').includes(t.id));
  if (!tasks.length) throw new Error(`no tasks match ${sel}`);
  const outDir = arg('out', path.join(CACHE, 'corpus'))!;
  const parallel = Math.max(1, Number(arg('parallel', '1')));
  const isolation = arg('isolation', 'systemd');
  if (isolation !== 'systemd' && isolation !== 'none') throw new Error('--isolation systemd|none');
  mkdirSync(outDir, { recursive: true });
  if (budgetConfig && existsSync(path.join(outDir, 'recording-budget.json'))) {
    throw new Error('Recording budget output already exists; preserve prior reservations and use a newly admitted batch directory');
  }
  const journal = budgetConfig ? recordingBudgetJournal(path.join(outDir, 'recording-budget.jsonl')) : undefined;
  let boundedGateway: Awaited<ReturnType<typeof startRecordingBudgetGateway>> | undefined;
  try {
    boundedGateway = budgetConfig ? await startRecordingBudgetGateway(budgetConfig, journal!.persist) : undefined;
  } catch (error) { journal?.close(); throw error; }
  const queue = [...tasks];
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        const m = await recordSession({
          corpus,
          task,
          cli,
          outDir,
          upstream: boundedGateway?.upstream ?? arg('upstream', 'http://127.0.0.1:8788')!,
          upstreamHeaders: boundedGateway?.headers,
          claudeModel: arg('claude-model', 'sonnet')!,
          codexSelection,
          requestLimit,
          keepWork: process.argv.includes('--keep-work'),
          isolation,
        });
        const mib = m.memPeakBytes == null ? '?' : (m.memPeakBytes / 2 ** 20).toFixed(0);
        const cpuS = m.cpuUsec == null ? '?' : (m.cpuUsec / 1e6).toFixed(1);
        console.log(`SESSION ${m.sessionId} exit=${m.exitCode} timedOut=${m.timedOut} wallMs=${m.wallMs} exchanges=${m.exchanges} peakMiB=${mib} cpuS=${cpuS} tools=${JSON.stringify(m.toolCalls)}`);
      } catch (e) {
        console.log(`SESSION_FAILED ${cli} ${task.id}: ${(e as Error).message}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: parallel }, worker));
  } finally {
    try { await boundedGateway?.stop(); } finally { journal?.close(); }
    if (requestLimit) {
      writeFileSync(path.join(outDir, 'recording-limit.json'), JSON.stringify(requestLimit.snapshot(), null, 2) + '\n');
    }
  }
}

if (process.argv[1] && /record-session\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
