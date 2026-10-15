#!/usr/bin/env -S npx tsx
/**
 * resume-spawn-live.ts — the LIVE-SMOKE rung for the wake-executor's REAL
 * claude/omp/codex resume spawn (closes the coordination-test-suite EI-153
 * accepted-gap: "Full real three-backend resume spawn").
 *
 * The CI test (`wake-resume-isolation.test.ts`) asserts the wake-executor BUILDS
 * the right resume command and hands it to `spawnDetached` (bin/args/env captured
 * via an injected `spawnDetached`) — but it never runs a real CLI, because a real
 * resume needs credentials. This smoke is the other half: it builds the SAME
 * command via the SAME `resumeCommandFor`, runs it against the REAL `claude` /
 * `omp` / `codex` binary in a per-session isolated transcript store,
 * and asserts the resume actually FOUND and CONTINUED the exact session — and
 * does so DETERMINISTICALLY (the session's transcript / rollout file GROWS),
 * independent of the model's semantic output.
 *
 * Faithfulness: resume commands come from `resumeCommandFor`; the Claude
 * config uses the maintained headless writer over a private credential copy.
 * The child cannot inherit the caller's control-plane identity or user hooks.
 *
 * Gated (needs live provider creds → never CI): surfaced as a `{kind:'node'}`
 * runner in the /adv Tests tab's coordination-suite domain. Each agent leg SKIPS
 * when its CLI is absent / unauthed; the smoke FAILS (exit non-zero) only when an
 * available, authed CLI's resume does NOT continue the session.
 *
 * Usage:
 *   npx tsx apps/operator/scripts/resume-spawn-live.ts            # claude + omp + codex
 *   npx tsx apps/operator/scripts/resume-spawn-live.ts --agent=claude
 *   PAPERCUSP_SMOKE_MODEL=claude-haiku-4-5-20251001 npx tsx … --agent=claude
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isCliEntry } from '../../../packages/operator-core/lib/util/cli-entry';
import { resumeCommandFor, wakeTurnText } from '../../../packages/operator-core/lib/events/await/wake-executor';
import type { DeliveryWork } from '../../../packages/operator-core/lib/events/await/types';
import { writeSpawnClaudeConfig } from '../../../libs/papercusp/packages/orchestrator/src/spawn-mcp';
import { readFleetClaudeToken } from '../../../libs/papercusp/packages/orchestrator/src/fleet-claude-token';
import { ompGatewayModelFromSpec, ompGatewayModelsConfig } from '../../../libs/papercusp/packages/orchestrator/src/omp-gateway-config';
import { tagTurnForInjection } from '../../../packages/operator-core/lib/turn-provenance/turn-provenance';
import { sanitizeInheritedWakeEnv, wakeAccountRouteFromArgv } from '../../../packages/operator-core/lib/inference-gateway/spawn-env';

// A cheap model keeps the smoke's ~4 real turns near-free. Override via env.
const CLAUDE_MODEL = process.env.PAPERCUSP_SMOKE_MODEL || 'claude-haiku-4-5-20251001';
const TURN_TIMEOUT_MS = Number(process.env.PAPERCUSP_SMOKE_TURN_TIMEOUT_MS) || 180_000;

type Leg = {
  agent: "claude" | "omp" | "codex";
  status: "pass" | "skip" | "fail";
  detail: string;
  version?: string;
  witness?: ReturnType<typeof retainResumeSmokeWitness>;
};

let evidenceDir: string | undefined;

/** Reuse the production OMP registry builder for an explicitly selected smoke account route. */
export function configureResumeSmokeOmpRoute(agentDir: string, sid: string, model?: string, account?: string) {
  if (!account || account === 'default') return model ? ['--model', model] : [];
  const route = ompGatewayModelFromSpec(model);
  if (!route) throw new Error('A gateway OMP smoke requires an explicit compatible provider/model');
  const config = ompGatewayModelsConfig({ provider: route.gatewayProvider, models: [route.modelId], ownerId: sid,
    gatewayOn: account === 'auto', accountId: account === 'auto' ? undefined : account });
  if (!config) throw new Error('OMP smoke account route did not produce a model registry');
  writeFileSync(join(agentDir, 'models.yml'), config.content, { mode: 0o600 });
  return ['--model', config.modelSelector];
}

/** Preserve the exact private transcript pair before the client profile is removed. */
export function retainResumeSmokeWitness(dir: string, agent: Leg['agent'], sessionId: string,
  before: string, after: string, wakeText: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stem = join(dir, `${agent}-${sessionId}`);
  const beforePath = `${stem}-before.jsonl`;
  const afterPath = `${stem}-after.jsonl`;
  writeFileSync(beforePath, before, { mode: 0o600 });
  writeFileSync(afterPath, after, { mode: 0o600 });
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return { sessionId, beforePath, afterPath, beforeSha256: hash(before), afterSha256: hash(after),
    exactPrefixAndNewWake: verifyResumeSmokeContinuation(before, after, wakeText), wakeText };
}

/** Acceptance cannot turn an absent client or an empty selection into a pass. */
export function resumeSmokeExitCode(legs: Pick<Leg, 'status'>[], requireAll: boolean): number {
  return !legs.length || legs.some((leg) => leg.status === 'fail' || (requireAll && leg.status === 'skip')) ? 1 : 0;
}

function retainWitness(agent: Leg['agent'], sessionId: string, before: string, after: string, wakeText: string) {
  return evidenceDir ? retainResumeSmokeWitness(evidenceDir, agent, sessionId, before, after, wakeText) : undefined;
}

export function resumeSmokeFailureDetail(result: { stdout: string; stderr: string;
  errorMessage?: string; errorCode?: string | null; signal?: string | null;
  elapsedMs?: number; timeoutMs?: number }): string {
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  const metadata = [result.errorCode && `errorCode=${result.errorCode}`, result.signal && `signal=${result.signal}`,
    result.elapsedMs !== undefined && `elapsed=${result.elapsedMs}ms`,
    result.timeoutMs !== undefined && `deadline=${result.timeoutMs}ms`].filter(Boolean).join(' ');
  return [metadata, output || result.errorMessage].filter(Boolean).join('\n')
    .replace(/sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|Bearer\s+\S+/g, '[redacted credential]').slice(0, 600);
}

function recordStage(agent: Leg['agent'], stage: string, result: ReturnType<typeof run>) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(evidenceDir, `${agent}-${stage}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
}

/** OMP now stores credentials in SQLite. Copy that table alone, through a read-only snapshot. */
export function seedResumeSmokeOmpAuth(sourceAgentDir: string, destinationAgentDir: string): boolean {
  const sourcePath = join(sourceAgentDir, 'agent.db');
  if (!existsSync(sourcePath)) return false;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let destination: DatabaseSync | undefined;
  try {
    const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_credentials'").get() as { sql: string } | undefined;
    if (!schema) return false;
    mkdirSync(destinationAgentDir, { recursive: true, mode: 0o700 });
    const destinationPath = join(destinationAgentDir, 'agent.db');
    writeFileSync(destinationPath, '', { mode: 0o600 });
    destination = new DatabaseSync(destinationPath);
    destination.exec(schema.sql);
    const columns = source.prepare('PRAGMA table_info(auth_credentials)').all() as Array<{ name: string }>;
    const names = columns.map(({ name }) => '"' + name.replaceAll('"', '""') + '"').join(',');
    const insert = destination.prepare(`INSERT INTO auth_credentials (${names}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of source.prepare('SELECT * FROM auth_credentials').all()) {
      insert.run(...columns.map(({ name }) => row[name] as string | number | null));
    }
    return true;
  } finally { destination?.close(); source.close(); }
}

/** Private auth inputs; no user settings, hooks, plugins, or write-through credential links. */
export function createResumeSmokeProfile(agent: Leg['agent'], sourceHome = homedir()) {
  const home = mkdtempSync(join(tmpdir(), `resume-smoke-${agent}-home-`));
  chmodSync(home, 0o700);
  const relative = agent === 'claude' ? ['.claude', '.credentials.json']
    : agent === 'codex' ? ['.codex', 'auth.json'] : ['.omp', 'agent', 'auth.json'];
  const source = join(sourceHome, ...relative);
  const destination = join(home, ...relative);
  mkdirSync(join(destination, '..'), { recursive: true, mode: 0o700 });
  if (existsSync(source)) {
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
  if (agent === 'omp') seedResumeSmokeOmpAuth(join(sourceHome, '.omp', 'agent'), join(home, '.omp', 'agent'));
  const clientHome = agent === 'claude'
    ? writeSpawnClaudeConfig(home, { persistentDir: join(home, '.claude-config') }).configDir
    : agent === 'codex' ? join(home, '.codex') : join(home, '.omp', 'agent');
  return { home, clientHome, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Strip caller control-plane identity before starting an acceptance client. */
export function resumeSmokeChildEnv(parent: NodeJS.ProcessEnv, home: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of Object.keys(env)) if (key.startsWith('PAPERCUSP_')) delete env[key];
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'OMP_CONFIG_DIR']) delete env[key];
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), ...overrides, PAPERCUSP_SID: '' };
}

/** A different rollout growing is never evidence that this exact session resumed. */
export function verifyResumeSmokeContinuation(before: string, after: string, wakeText: string): boolean {
  const prior = before.split('\n').filter((line) => line.trim());
  const current = after.split('\n').filter((line) => line.trim());
  if (!prior.length || current.length <= prior.length ||
    !current.slice(0, prior.length).every((line, index) => line === prior[index])) return false;
  const containsWake = (value: unknown): boolean => typeof value === 'string' ? value.includes(wakeText)
    : Array.isArray(value) ? value.some(containsWake)
      : !!value && typeof value === 'object' && Object.values(value).some(containsWake);
  // Native transcript strings encode newlines and quotes. Inspect decoded NEW
  // records; searching serialized bytes rejects the real multiline wake text.
  try { return current.slice(prior.length).map(line => JSON.parse(line)).some(containsWake); }
  catch { return false; }
}

function log(s: string) {
  process.stdout.write(s + '\n');
}

/** Keep the measured deadline and termination cause even when a CLI emits nothing. */
export function runResumeSmokeCommand(bin: string, args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }) {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? TURN_TIMEOUT_MS;
  try {
    const stdout = execFileSync(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '', elapsedMs: Date.now() - startedAt, timeoutMs,
      errorCode: null, signal: null, timedOut: false, errorMessage: '' };
  } catch (e: any) {
    return { code: e?.status ?? 1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? ''),
      elapsedMs: Date.now() - startedAt, timeoutMs, errorCode: e?.code ? String(e.code) : null,
      signal: e?.signal ?? null, timedOut: e?.code === 'ETIMEDOUT',
      errorMessage: resumeSmokeFailureDetail({ stdout: '', stderr: String(e?.message ?? '') }) };
  }
}

const run = runResumeSmokeCommand;

/** Count newline-delimited records in a JSONL file (0 if absent). */
function jsonlLines(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Enroll the exact prompt bytes before handing them to a real CLI. */
async function tagSmokeTurn(sid: string, text: string, dir: string): Promise<string | null> {
  const tagged = await tagTurnForInjection({ sid, origin: 'resume-smoke', text, dir });
  return tagged.ledgerWritten ? tagged.taggedText : null;
}

/** Find `<root>/**​/<needle>` (first match) — claude hashes cwd into the projects
 *  subdir, and codex nests rollouts by date, so we locate the file by name. */
function findFile(root: string, predicate: (name: string, full: string) => boolean): string | null {
  let stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (predicate(e.name, full)) return full;
    }
  }
  return null;
}

function isClaudeAuthed(): boolean {
  return !!readFleetClaudeToken() || existsSync(join(homedir(), '.claude', '.credentials.json'));
}
function isCodexAuthed(): boolean {
  return existsSync(join(homedir(), '.codex', 'auth.json'));
}
function onPath(bin: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ── claude leg ────────────────────────────────────────────────────────────
async function claudeLeg(): Promise<Leg> {
  if (!onPath('claude')) return { agent: 'claude', status: 'skip', detail: 'claude not on PATH' };
  if (!isClaudeAuthed()) return { agent: 'claude', status: 'skip', detail: 'no ~/.claude/.credentials.json' };

  const sid = `smoke-${randomUUID()}`;
  const sessionId = randomUUID(); // forced native session id (claude --session-id)
  const profile = createResumeSmokeProfile('claude');
  const configDir = profile.clientHome;
  const cwd = mkdtempSync(join(tmpdir(), 'resume-smoke-claude-'));
  const provenanceDir = mkdtempSync(join(tmpdir(), 'resume-smoke-provenance-'));
  const account = process.env.PAPERCUSP_SMOKE_CLAUDE_ACCOUNT;
  const accountRoute = account ? wakeAccountRouteFromArgv(['--account', account], sid) : null;
  const fleetToken = !accountRoute || accountRoute.mode === 'default' ? readFleetClaudeToken() : null;
  const env = resumeSmokeChildEnv(sanitizeInheritedWakeEnv(process.env), profile.home, {
    CLAUDE_CONFIG_DIR: configDir,
    PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
    ...(fleetToken ? { CLAUDE_CODE_OAUTH_TOKEN: fleetToken } : {}),
    ...accountRoute?.env,
  });

  try {
    // 1. Fresh launch: force --session-id so resume can target it EXACTLY (the
    //    same flag the launcher's suLaunchArgs forces, plus headless -p).
    log('  claude: launching a fresh session (forced --session-id)…');
    const launchText = await tagSmokeTurn(sid, 'Reply with the single word READY.', provenanceDir);
    if (!launchText) {
      return { agent: 'claude', status: 'fail', detail: 'turn-provenance ledger write failed before fresh launch' };
    }
    const launch = run(
      'claude',
      [...(accountRoute?.claudeArgs ?? []), '--session-id', sessionId, '-p', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
        '--model', CLAUDE_MODEL, launchText],
      { cwd, env },
    );
    recordStage('claude', 'launch', launch);
    if (launch.code !== 0) {
      return { agent: 'claude', status: 'fail', detail: `fresh launch exited ${launch.code}: ${resumeSmokeFailureDetail(launch)}` };
    }
    const transcript = findFile(join(configDir, 'projects'), (n) => n === `${sessionId}.jsonl`);
    if (!transcript) {
      return { agent: 'claude', status: 'fail', detail: `no transcript ${sessionId}.jsonl under the isolated config dir's projects/ after launch` };
    }
    const before = jsonlLines(transcript);
    const beforeText = readFileSync(transcript, 'utf8');

    // 2. Resume via the REAL wake-executor command builder (zero drift) — and
    //    with the REAL wake turn text (coord-e2e P-009: the resume path of
    //    wake-on-message). The prompt is exactly what executeWake's resume rung
    //    would inject for an always-armed inbox-wake fired by a directed
    //    coord:send {wake:true}, so this leg proves the message-bearing wake
    //    renders in the woken session's transcript, not just that resume works.
    const wakePayload = wakeTurnText({
      id: 9001,
      eventKey: `coord:inbox-wake:${sid}`,
      note: 'always-armed inbox-wake (resume-spawn-live P-009 rung)',
      summary: 'coord:send wake-rung ping — read your inbox',
      payload: null,
    } as DeliveryWork) + ' Reply with the single word AGAIN.';
    const wakeText = await tagSmokeTurn(sid, wakePayload, provenanceDir);
    if (!wakeText) {
      return { agent: 'claude', status: 'fail', detail: 'turn-provenance ledger write failed before resume' };
    }
    const cmd = resumeCommandFor({ agent: 'claude', sessionId, ompThreadId: null }, wakeText, accountRoute);
    if (!cmd) return { agent: 'claude', status: 'fail', detail: 'resumeCommandFor returned null for a claude session with a sessionId' };
    log(`  claude: resuming via \`${cmd.bin} ${cmd.args.filter((a) => a !== wakeText).join(' ')} <wake-turn-text>\``);
    const resumeStartedAt = Date.now();
    const resume = run(cmd.bin, cmd.args, { cwd, env });
    recordStage('claude', 'resume', resume);
    const resumeMs = Date.now() - resumeStartedAt;
    if (resume.code !== 0) {
      return { agent: 'claude', status: 'fail', detail: `resume exited ${resume.code}: ${resumeSmokeFailureDetail(resume)}` };
    }

    // 3. Deterministic proof: the resume appended turns to the SAME transcript —
    //    so `--resume <uuid>` found + continued the exact session (not a new one)
    //    — AND the appended content carries the wake turn (the coord message
    //    reference the woken session acts on).
    const after = jsonlLines(transcript);
    if (after <= before) {
      return { agent: 'claude', status: 'fail', detail: `resume did not grow the session transcript (${before} → ${after} lines) — it did not continue the session` };
    }
    const transcriptText = readFileSync(transcript, 'utf8');
    const witness = retainWitness('claude', sessionId, beforeText, transcriptText, wakeText);
    if (!verifyResumeSmokeContinuation(beforeText, transcriptText, wakeText)) {
      return { agent: 'claude', status: 'fail', detail: 'resumed transcript grew but does NOT contain the injected wake turn text — the wake prompt did not reach the session' };
    }
    return {
      agent: "claude",
      status: "pass",
      witness,
      detail: `resumed exact session ${sessionId.slice(0, 8)}… in ${resumeMs}ms; transcript ${before} → ${after} lines; wake turn text present in the resumed turn`,
    };
  } finally {
    profile.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(provenanceDir, { recursive: true, force: true });
  }
}

// ── OMP leg ───────────────────────────────────────────────────────────────
async function ompLeg(): Promise<Leg> {
  if (!onPath('omp')) return { agent: 'omp', status: 'skip', detail: 'omp not on PATH' };

  const sid = `smoke-${randomUUID()}`;
  // PI_CODING_AGENT_DIR is the production OMP session-store override. Keeping
  // it isolated proves both fresh and resume resolve the exact same thread
  // without reading or mutating the owner's normal ~/.omp/agent/sessions tree.
  const profile = createResumeSmokeProfile('omp');
  const ompAgentDir = profile.clientHome;
  const modelArgs = configureResumeSmokeOmpRoute(ompAgentDir, sid,
    process.env.PAPERCUSP_SMOKE_OMP_MODEL, process.env.PAPERCUSP_SMOKE_OMP_ACCOUNT);
  const cwd = mkdtempSync(join(tmpdir(), 'resume-smoke-omp-'));
  const provenanceDir = mkdtempSync(join(tmpdir(), 'resume-smoke-provenance-'));
  const env = resumeSmokeChildEnv(process.env, profile.home, {
    PI_CODING_AGENT_DIR: ompAgentDir,
    PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
  });

  try {
    log('  omp: launching a fresh print-mode session…');
    const launchText = await tagSmokeTurn(sid, 'Reply with the single word READY.', provenanceDir);
    if (!launchText) {
      return { agent: 'omp', status: 'fail', detail: 'turn-provenance ledger write failed before fresh launch' };
    }
    const launch = run(
      'omp',
      [...modelArgs, '--approval-mode', 'yolo', '-p', launchText],
      { cwd, env },
    );
    recordStage('omp', 'launch', launch);
    if (launch.code !== 0) {
      const detail = resumeSmokeFailureDetail(launch);
      if (/unauth|not authenticated|api key|credential|login required/i.test(detail)) {
        return { agent: 'omp', status: 'skip', detail: `OMP is installed but not authenticated: ${detail}` };
      }
      return { agent: 'omp', status: 'fail', detail: `fresh launch exited ${launch.code}: ${detail}` };
    }

    const transcript = findFile(join(ompAgentDir, 'sessions'), (n) => n.endsWith('.jsonl'));
    if (!transcript) {
      return { agent: 'omp', status: 'fail', detail: `no session JSONL under ${join(ompAgentDir, 'sessions')} after launch` };
    }
    const match = transcript.match(/_([0-9a-z-]{8,})\.jsonl$/i);
    if (!match) {
      return { agent: 'omp', status: 'fail', detail: `could not parse an OMP thread id from session file: ${transcript}` };
    }
    const threadId = match[1];
    const before = jsonlLines(transcript);
    const beforeText = readFileSync(transcript, 'utf8');

    const wakePayload = wakeTurnText({ id: 9002, eventKey: `coord:inbox-wake:${sid}`,
      note: 'resume-spawn-live OMP wake', summary: 'coord:send wake-rung ping', payload: null } as DeliveryWork);
    const resumeText = await tagSmokeTurn(sid, wakePayload + ' Reply with the single word AGAIN.', provenanceDir);
    if (!resumeText) {
      return { agent: 'omp', status: 'fail', detail: 'turn-provenance ledger write failed before resume' };
    }
    const cmd = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: threadId }, resumeText);
    if (!cmd) return { agent: 'omp', status: 'fail', detail: 'resumeCommandFor returned null for an OMP thread id' };
    log(`  omp: resuming via \`${cmd.bin} -r ${threadId.slice(0, 8)}… --approval-mode yolo -p <text>\``);
    const resumeStartedAt = Date.now();
    const resume = run(cmd.bin, cmd.args, { cwd, env });
    recordStage('omp', 'resume', resume);
    const resumeMs = Date.now() - resumeStartedAt;
    if (resume.code !== 0) {
      return { agent: 'omp', status: 'fail', detail: `resume exited ${resume.code}: ${resumeSmokeFailureDetail(resume)}` };
    }

    const after = jsonlLines(transcript);
    const afterText = readFileSync(transcript, 'utf8');
    const witness = retainWitness('omp', threadId, beforeText, afterText, resumeText);
    if (!verifyResumeSmokeContinuation(beforeText, afterText, resumeText)) {
      return { agent: 'omp', status: 'fail', detail: `resume did not grow the session transcript (${before} → ${after} lines)` };
    }
    return { agent: 'omp', status: 'pass', witness, detail: `resumed exact thread ${threadId.slice(0, 8)}… in ${resumeMs}ms; transcript ${before} → ${after} lines` };
  } finally {
    profile.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(provenanceDir, { recursive: true, force: true });
  }
}

// ── codex leg ─────────────────────────────────────────────────────────────
async function codexLeg(): Promise<Leg> {
  if (!onPath('codex')) return { agent: 'codex', status: 'skip', detail: 'codex not on PATH' };
  if (!isCodexAuthed()) return { agent: 'codex', status: 'skip', detail: 'no ~/.codex/auth.json' };

  const sid = `smoke-${randomUUID()}`;
  // A minimal per-session CODEX_HOME: just a private ChatGPT OAuth copy (the resume
  // rung doesn't need MCP; writeSuCodexHome's full home is exercised elsewhere).
  const profile = createResumeSmokeProfile('codex');
  const codexHome = profile.clientHome;
  const cwd = mkdtempSync(join(tmpdir(), 'resume-smoke-codex-'));
  const provenanceDir = mkdtempSync(join(tmpdir(), 'resume-smoke-provenance-'));
  const env = resumeSmokeChildEnv(process.env, profile.home, {
    CODEX_HOME: codexHome,
    PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
  });

  const sessionsRoot = join(codexHome, 'sessions');
  try {
    // 1. Fresh headless session.
    log('  codex: launching a fresh exec session…');
    const launchText = await tagSmokeTurn(sid, 'Reply with the single word READY.', provenanceDir);
    if (!launchText) {
      return { agent: 'codex', status: 'fail', detail: 'turn-provenance ledger write failed before fresh launch' };
    }
    const launch = run(
      'codex',
      ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', launchText],
      { cwd, env },
    );
    recordStage('codex', 'launch', launch);
    if (launch.code !== 0) {
      return { agent: 'codex', status: 'fail', detail: `fresh exec exited ${launch.code}: ${resumeSmokeFailureDetail(launch)}` };
    }
    // Recover the conversation uuid from the rollout filename (rollout-<ts>-<uuid>.jsonl).
    const rollout = findFile(sessionsRoot, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    if (!rollout) {
      return { agent: 'codex', status: 'fail', detail: `no rollout-*.jsonl under ${sessionsRoot} after exec` };
    }
    const m = rollout.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
    if (!m) return { agent: 'codex', status: 'fail', detail: `could not parse a session uuid from rollout name: ${rollout}` };
    const sessionId = m[1];
    const before = jsonlLines(rollout);
    const beforeText = readFileSync(rollout, 'utf8');

    // 2. Resume via the REAL wake-executor builder (`codex exec … resume <uuid>`).
    const wakePayload = wakeTurnText({ id: 9003, eventKey: `coord:inbox-wake:${sid}`,
      note: 'resume-spawn-live Codex wake', summary: 'coord:send wake-rung ping', payload: null } as DeliveryWork);
    const resumeText = await tagSmokeTurn(sid, wakePayload + ' Reply with the single word AGAIN.', provenanceDir);
    if (!resumeText) {
      return { agent: 'codex', status: 'fail', detail: 'turn-provenance ledger write failed before resume' };
    }
    const cmd = resumeCommandFor({ agent: 'codex', sessionId, ompThreadId: null }, resumeText);
    if (!cmd) return { agent: 'codex', status: 'fail', detail: 'resumeCommandFor returned null for a codex session with a sessionId' };
    log(`  codex: resuming via \`${cmd.bin} ${cmd.args.filter((a) => a !== resumeText).join(' ')} <text>\``);
    const resumeStartedAt = Date.now();
    const resume = run(cmd.bin, ['exec', '--skip-git-repo-check', ...cmd.args.slice(1)], { cwd, env });
    recordStage('codex', 'resume', resume);
    const resumeMs = Date.now() - resumeStartedAt;
    if (resume.code !== 0) {
      return { agent: 'codex', status: 'fail', detail: `resume exited ${resume.code}: ${resumeSmokeFailureDetail(resume)}` };
    }

    // 3. Deterministic proof: this exact rollout grew with the wake prompt.
    const after = jsonlLines(rollout);
    const afterText = readFileSync(rollout, 'utf8');
    const witness = retainWitness('codex', sessionId, beforeText, afterText, resumeText);
    if (!verifyResumeSmokeContinuation(beforeText, afterText, resumeText)) {
      return { agent: 'codex', status: 'fail', detail: `resume did not grow the session rollout (${before} → ${after} lines)` };
    }
    return {
      agent: "codex",
      status: "pass",
      witness,
      detail: `resumed session ${sessionId.slice(0, 8)}… in ${resumeMs}ms; rollout ${before} → ${after} lines`,
    };
  } finally {
    profile.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(provenanceDir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length) || null;
  if (only && !['claude', 'omp', 'codex'].includes(only)) throw new Error(`Unknown agent: ${only}`);
  const requireAll = argv.includes('--require-all');
  const evidenceArg = argv.find((a) => a.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length);
  evidenceDir = evidenceArg ? resolve(evidenceArg) : undefined;

  log(
    "resume-spawn-live — real claude/omp/codex resume rung (EI-153 live-smoke)\n",
  );
  const legs: Leg[] = [];
  if (!only || only === 'claude') legs.push(await claudeLeg());
  if (!only || only === "omp") legs.push(await ompLeg());
  if (!only || only === 'codex') legs.push(await codexLeg());
  for (const leg of legs) {
    const version = run(leg.agent, ['--version'], { cwd: process.cwd(), env: process.env });
    leg.version = version.code === 0 ? version.stdout.trim() : 'unavailable';
  }
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(evidenceDir, 'outcomes.json'), JSON.stringify({ at: new Date().toISOString(), requireAll,
      exitCode: resumeSmokeExitCode(legs, requireAll), legs }, null, 2), { mode: 0o600 });
  }

  log('');
  if (requireAll && legs.some((l) => l.status === 'skip')) {
    log('FAIL — required acceptance contains a skipped client.');
    process.exit(1);
  }
  for (const l of legs) {
    const icon = l.status === 'pass' ? '✅' : l.status === 'skip' ? '⚪' : '❌';
    log(`${icon} ${l.agent}: ${l.status.toUpperCase()} — ${l.detail}`);
  }

  const failed = legs.filter((l) => l.status === 'fail');
  const ran = legs.filter((l) => l.status !== 'skip');
  log('');
  if (failed.length) {
    log(`FAIL — ${failed.length}/${legs.length} leg(s) failed.`);
    process.exit(1);
  }
  if (ran.length === 0) {
    log(
      "SKIP — no authed CLI available (claude/omp/codex). Nothing to verify on this box.",
    );
    process.exit(0);
  }
  log(`OK — ${ran.length} leg(s) verified a real resume continued the exact session.`);
  process.exit(0);
}

if (isCliEntry(import.meta.url)) {
  main().catch((e) => {
    log(`resume-spawn-live: ${e?.message ?? e}`);
    process.exit(2);
  });
}
