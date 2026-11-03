/**
 * role-codex-home.ts — materialize a per-session CODEX_HOME for an
 * INTERACTIVE codex role session (psu --role=<role> --agent=codex).
 *
 * codex has no `--append-system-prompt` / `--mcp-config` flags: its system
 * prompt is `$CODEX_HOME/AGENTS.md` and its MCP servers are declared in
 * `$CODEX_HOME/config.toml`. So a codex role session needs a dedicated
 * CODEX_HOME, exactly like the `codex-su` wrapper uses for the SU playbook
 * (install-standalone-mcp.sh §4f) — but per-session and role-scoped.
 *
 * This mirrors the orchestrator's `writeSignedSpawnCodexHome`
 * (libs/papercusp/.../spawn-mcp.ts) with one deliberate difference: it
 * consumes an ALREADY-SIGNED url (from `buildRoleLaunchSpec`, the same
 * signed role-scoped url claude/omp role sessions get) instead of signing
 * its own params. All three backends therefore share one signed url per
 * session — the dispatch layer enforces the role allowlist identically
 * (D-001).
 *
 * Layout:
 *   $CODEX_HOME/AGENTS.md     — the role prompt (codex's instruction file)
 *   $CODEX_HOME/config.toml   — [mcp_servers.papercusp] url = "<signed>"
 *                               (sig-auth; no bearer, unlike codex-su)
 *   $CODEX_HOME/auth.json     — symlink → ~/.codex/auth.json (shared
 *                               ChatGPT OAuth; a SYMLINK so token rotation
 *                               happens in-place and never diverges from
 *                               the real login — copying would risk a
 *                               single-use refresh-token logout).
 *
 * HISTORICAL GAP (D-002, owner-inbox-single-pane-2026-07-17), now partly
 * superseded: when this was written codex's hook surface was
 * PreToolUse/PostToolUse only. Current codex (0.159+) ships a `Stop` event,
 * which `writeCodexLockHooks` now uses for the identity stop port and the
 * turn-end journal (WI-10006795). The text below records the original
 * decision about owner-directed questions; it has not been re-evaluated. That meant the
 * su convention "an owner-directed question must ride a durable channel"
 * (coord:escalate w/ options, or an `<ask>` block at minimum) cannot be
 * enforced or even soft-nudged for a Codex role session the way Claude's
 * Stop-bounce or OMP's turn_end capture+followUp can — it is
 * convention-only here, backstopped only by the transcript watcher (P-002)
 * detecting a pending owner-gate after the fact. This is a RECORDED
 * decision, not a bug to file later — see
 * /internal/docs/agent-insights/su-owner-ask-capability-matrix for the full
 * per-client matrix. Re-evaluate if codex ever ships a genuine turn-end hook.
 *
 * Server-only.
 */
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { papercuspHome } from '@papercusp/host-platform/home';
import { parse as parseToml } from '@iarna/toml';
import { CODEX_CAPABILITY_CONTROLS } from '@papercusp/orchestrator/managed-capability-policy';
import {
  codexHomeForSessionKey,
  codexSqliteHomeForSessionKey,
} from '@papercusp/orchestrator/session-launch-dirs';
import {
  CODEX_MANAGED_DISPATCHER_APPROVAL_TOML,
  CODEX_MANAGED_MODEL_CATALOG_FILE,
  codexGatewayConfigToml,
  codexManagedFeaturesToml,
  codexModelCatalogToml,
  materializeStrippedCodexModelCatalog,
  publishCodexConfig,
  tomlEscape,
  type CodexModelCatalogMaterialized,
} from '@papercusp/orchestrator/codex-gateway-config';
import { readCodexLockRuntimeVerdict, type CodexLockRuntimeVerdict } from './codex-lock-runtime';
import { lintInstructionText, type InstructionLintReport, type InstructionRuntimeContext } from './instruction-lint';
import {
  buildContextBudget,
  codexContextConfigToml,
  codexModelConfigToml,
  resolveCodexModel,
} from './model-context-budget.mjs';
import { runCodexHomeMaterializerJob, type CodexHomeMaterializerJob } from './role-codex-home-offload';

/**
 * WI-6554700010009552: the async APIs run the synchronous materializers in a
 * worker thread (role-codex-home-offload.ts). A worker resolves `os.homedir()`
 * on its own, so it could judge or write a home against a different user home
 * than the caller resolved: module mocks do not cross the worker boundary, and
 * a test then read the REAL ~/.papercusp/hooks/cc and ~/.codex. Every
 * enqueue passes the caller's home as `job.homeDir`, and
 * executeCodexHomeMaterializerJob scopes it here for that one job. Outside a
 * job this is plain `os.homedir()`.
 */
let materializerHomeOverride: string | undefined;
function homedir(): string {
  return materializerHomeOverride ?? osHomedir();
}

// Match desktop-install's installed destination, independently of the workspace
// data root in PAPERCUSP_HOME. Reuse this path for enrollment AND repair checks
// so a missing workspace copy cannot hide an installed journal or guard.
function installedHookPath(...parts: string[]): string {
  return join(papercuspHome({}, homedir()), 'hooks', ...parts);
}

import { dirname as __esmDirname } from 'node:path';
import { fileURLToPath as __esmFileURLToPath } from 'node:url';

// ESM-safe __dirname (plugin-host-runtime.ts pattern): bare __dirname is
// UNDEFINED under tsx file-mode in this type:module package — referencing it
// throws at import (top-level) or call time. This class of bug killed DBOS
// routines fleet-wide on the 2026-06-12 05:30 deploy (change-ledger-scan).
const __dirname = __esmDirname(__esmFileURLToPath(import.meta.url));

export interface RoleCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** Fast, session-keyed directory configured as Codex's `sqlite_home`. */
  sqliteHome: string;
  /** The AGENTS.md (role prompt) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (role-scoped MCP) path — diagnostics. */
  configPath: string;
  /** Lint of the exact AGENTS.md written after runtime lock-mode resolution. */
  instructionLint: InstructionLintReport;
}

// ── Shared codex-home internals (role + su) ───────────────────────────

/** codex's file-edit tool is `apply_patch` (canonical); `Edit`/`Write` are
 *  documented matcher aliases. (developers.openai.com/codex/hooks, PR #18391) */
const CODEX_LOCK_PRE_MATCHER = 'apply_patch|Edit|Write';
/** EI-211603: a failed code-mode `apply_patch` can omit its nested
 *  PostToolUse event. The parent code-mode call still completes, so the
 *  release hook also observes its canonical/compatibility aliases and can
 *  recover only the cached lock paths named in that parent's source. */
const CODEX_LOCK_POST_MATCHER = `^(?:${CODEX_LOCK_PRE_MATCHER}|exec|functions\\.exec|functions__exec)$`;
/** The shared content guard understands both Codex's raw apply_patch payload and
 * the Claude-compatible edit/write aliases projected by MCP servers. */
const CODEX_CONTROL_BYTES_PRE_MATCHER =
  '^(?:apply_patch|Edit|Write|MultiEdit|mcp__.*__capability_(?:edit|write|multi_?edit))$';
/** Full Write/capability:write inputs carry the complete requested content, so
 * the shared PostToolUse guard can compare exact UTF-8 bytes on disk. */
const CODEX_WRITE_BYTE_INTEGRITY_MATCHER = '^(?:Write|mcp__.*__capability_write)$';
/** The shared cc/ turn-end journal hook (WI-10006795). One name, read by both the
 * writer and the identity repair, so a home missing it is repaired on resume. */
const CODEX_TURN_JOURNAL_HOOK = 'stop-turn-journal.sh';
/** WI-6554700010009447: the Codex RTK rewrite hook. Every codex shell handler
 *  reports tool_name "Bash" to hooks (codex-rs core/src/tools/hook_names.rs). */
export const CODEX_RTK_REWRITE_HOOK = 'pretooluse-codex-rtk-rewrite.mjs';
const CODEX_RTK_REWRITE_MATCHER = '^Bash$';
/** The shared shell guard every Codex home runs (WI-6554700010017981). */
const CODEX_BASH_GATE_HOOK = 'pretooluse-bash-resource-gate.sh';
const CODEX_BASH_GATE_MATCHER = 'Bash|exec_command|local_shell|shell';

/**
 * TOML preamble baked into EVERY per-session codex home (psu-isolation P-004 /
 * D-001) — isolate a psu codex session from the launching user's project doc +
 * codex's native memory, so it is steered ONLY by the home's AGENTS.md (the psu
 * playbook + the P-001 project-guide splice) and uses the hybrid `memory:*` MCP.
 *
 *  - `project_doc_max_bytes = 0` — codex otherwise reads `<cwd>/AGENTS.md` (on the
 *    papercup tree that's a symlink to `CLAUDE.md` = the project guide) and merges
 *    it into instructions. Now redundant: the guide reaches the session via the
 *    home's AGENTS.md. Capping at 0 drops the cwd read — a single delivery path,
 *    consistent with the claude/omp isolation.
 *  - `[features] memories = false` — disable codex's native memory tool so the
 *    agent doesn't read/write the native `memories_*.sqlite` store and instead uses
 *    `memory:*`. (A fresh launch also resets generated home state and its
 *    SQLite companion, retaining native transcripts; this stops within-session use.) The flag was
 *    `memory_tool` through codex 0.137; codex 0.142 renamed it to `memories` and
 *    `memory_tool` is now a deprecated legacy alias that prints a boot warning
 *    (`codex doctor`: "legacy alias memory_tool -> memories"). We write the modern
 *    `memories` key — verified valid under `codex --strict-config` on 0.142.5.
 *  - `[features] remote_compaction_v2 = false` — Codex 0.147 enables native
 *    remote compaction by default. Papercusp owns the semantic stopping point,
 *    carry note, and session restart, so a native cut would bypass the durable
 *    handoff and must not race the managed path (agent-managed-compaction D-011).
 *
 * Must precede any `[table]` (TOML top-level keys before tables); the `[mcp_servers]`
 * table each writer appends comes after.
 */
/**
 * Plan client-native-features-adoption-2026-10-21 D-005 route 2. A home that is
 * NOT routed through the inference gateway lets Codex read its own backend's
 * model catalog, and that catalog's multi_agent fields switch native subagent
 * tools on whatever `[features]` says. Such a home runs on a stripped copy
 * (`model_catalog_json`); a gateway-routed home needs none, because the gateway
 * strips the catalog it serves. Throws when no catalog source exists rather
 * than launching with subagent tools.
 */
function materializeHomeModelCatalog(
  codexHome: string,
  gatewayRouted: boolean,
): CodexModelCatalogMaterialized | null {
  return gatewayRouted ? null : materializeStrippedCodexModelCatalog({ codexHome });
}

function codexIsolationPreamble(
  headless = false,
  capabilityPolicy?: NonNullable<Parameters<typeof codexManagedFeaturesToml>[0]>['capabilityPolicy'],
): string {
  return [
    '# psu prompt isolation (P-004 / D-001): no cwd AGENTS.md read; native memory off.',
    'project_doc_max_bytes = 0',
    '',
    ...codexManagedFeaturesToml({ headless, capabilityPolicy }),
  ].join('\n');
}

const CODEX_LOCK_GUIDANCE_RE =
  /<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-START -->[\s\S]*?<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-END -->/g;

function codexLockEnforcementNote(verdict: CodexLockRuntimeVerdict): string {
  const marker = verdict.lockMode === 'automatic' ? 'automatic-hooks' : 'explicit-manual';
  return [
    '---',
    '## Codex Lock Enforcement Status',
    '',
    `<!-- papercusp-rule:file-locking=${marker} -->`,
    `- **Effective lockMode:** \`${verdict.lockMode}\` (hook health: \`${verdict.hookHealth}\`; runtimeProbed: \`${verdict.runtimeProbed}\`; generation: \`${verdict.generation}\`).`,
    `- **Effective instruction:** ${verdict.effectiveInstruction}`,
    `- **Why:** ${verdict.reason}`,
    '- **Resync:** `coord:orient.codexLocks` is authoritative after launch. Replace this snapshot when its generation changes; never merge automatic and manual instructions.',
    '',
  ].join('\n');
}

// The gateway config-TOML builder + tomlEscape are SHARED with the spawned-agent path
// (orchestrator's spawn-mcp.ts writeSignedSpawnCodexHome) via the package's
// `@papercusp/orchestrator/codex-gateway-config` subpath export (imported above) — WI-3645:
// the two local copies had drifted (this one still REQUIRED an account pin, which is why
// interactive `auto` stayed unwired for codex). One builder, one behavior: a pin renders the
// x-papercusp-account header; `gatewayOn` without a pin renders the SAME provider block with
// the header omitted (the gateway auto-selects); neither renders nothing.

/** Single-quote a value for a shell command (env prefix). */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Workspace root the lock hooks scope to — the parent of the declared
 * canonical edit tree. The serving module can live in a release/candidate
 * checkout, so its location cannot define an agent's edit scope. */
function resolveWorkspaceRoot(): string {
  const canonical = process.env.PAPERCUSP_CANONICAL_TREE?.trim();
  if (canonical && isAbsolute(canonical)) return __esmDirname(canonical);
  return process.env.PAPERCUSP_WORKSPACE_ROOT?.trim() || join(homedir(), 'papercupai-workspace');
}

/** Rebuild generated launch state, retaining native transcript custody.
 *  Only the archive/retention path may retire transcripts. A retry of a fresh
 *  launch can reuse an ADV home containing earlier native sessions.
 *  Share ChatGPT OAuth via a SYMLINK (never copy a single-use refresh token). */
function freshCodexHome(codexHome: string, inheritAmbientContext = true): string {
  if (existsSync(codexHome)) {
    if (!lstatSync(codexHome).isDirectory()) {
      throw new Error('Cannot rebuild Codex home: expected a real directory');
    }
    const entries = readdirSync(codexHome, { withFileTypes: true });
    const transcriptRoots = new Set(['sessions', 'archived_sessions']);
    // Validate every retained root before removing ANY generated file. Never
    // follow a symlink into another home or silently discard native history.
    for (const entry of entries) {
      if (transcriptRoots.has(entry.name) && !entry.isDirectory()) {
        throw new Error(`Cannot rebuild Codex home: transcript root ${entry.name} must be a real directory`);
      }
    }
    for (const entry of entries) {
      if (!transcriptRoots.has(entry.name)) {
        rmSync(join(codexHome, entry.name), { recursive: true, force: true });
      }
    }
  }
  mkdirSync(codexHome, { recursive: true });
  if (inheritAmbientContext) inheritUserCodexHome(codexHome);
  ensureCodexSkillWatchRoots({ codexHome });
  return codexHome;
}

/** Rebuild the disposable/high-write SQLite companion for a fresh launch. */
function freshCodexSqliteHome(sessionKey: string | number): string {
  const sqliteHome = codexSqliteHomeForSessionKey(sessionKey);
  rmSync(sqliteHome, { recursive: true, force: true });
  mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  return sqliteHome;
}

/** Older home rebuilds could move SQLite with the serving TMPDIR without
 * updating the launch receipt. Recover only a missing receipt location, with
 * positive proof from the retained native index and this owner's transcript.
 * An extant alternative or any missing/foreign proof remains a conflict. */
function verifiedRetainedCodexSqliteHome(codexHome: string, sessionKey: string | number,
  recordedHome: string, sqliteHome: string, sid?: string): boolean {
  try {
    if (!sid || existingCodexHomeOwnerSid(codexHome) !== sid) return false;
    const expectedName = `session-${sessionKey}`;
    if (basename(recordedHome) !== expectedName || basename(sqliteHome) !== expectedName ||
        !lstatSync(sqliteHome).isDirectory()) return false;
    try {
      lstatSync(recordedHome);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const index = readdirSync(sqliteHome).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0];
    if (!index || !lstatSync(join(sqliteHome, index)).isFile()) return false;
    const db = new Database(join(sqliteHome, index), { readonly: true, fileMustExist: true, timeout: 1000 });
    let thread: { id: string; rollout_path: string } | undefined;
    try {
      thread = db.prepare('SELECT id, rollout_path FROM threads ORDER BY updated_at DESC LIMIT 1')
        .get() as typeof thread;
    } finally { db.close(); }
    if (!thread || typeof thread.id !== 'string' || !thread.id || typeof thread.rollout_path !== 'string') return false;
    const sessions = join(realpathSync(codexHome), 'sessions');
    if (realpathSync(sessions) !== sessions) return false;
    const transcript = realpathSync(thread.rollout_path);
    const rel = relative(sessions, transcript);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) ||
        !lstatSync(thread.rollout_path).isFile()) return false;
    const fd = openSync(transcript, 'r');
    let firstLine: string;
    try {
      const bytes = Buffer.alloc(64 * 1024);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, count).indexOf(0x0a);
      if (end < 0) return false;
      firstLine = bytes.subarray(0, end).toString('utf8');
    } finally { closeSync(fd); }
    const meta = JSON.parse(firstLine);
    return meta?.type === 'session_meta' && meta.payload?.id === thread.id;
  } catch {
    // Recovery is evidence-gated. Never create an empty replacement database
    // or turn a corrupt/unreadable index into permission to ignore a conflict.
    return false;
  }
}

/** A resume must retain its recorded state location even when the serving
 * operator has a different TMPDIR or SQLite-root override from the launch. */
function preservedCodexSqliteHome(codexHome: string, sessionKey: string | number, recordedHome?: string | null, allowUnreadableConfig = false, requireExistingBinding = false, sid?: string): string {
  if (recordedHome && (!isAbsolute(recordedHome) || recordedHome.includes('\0'))) {
    throw new Error('Cannot repair Codex home: recorded sqlite_home must be an absolute path');
  }
  const configPath = join(codexHome, 'config.toml');
  if (!existsSync(configPath)) {
    if (requireExistingBinding) throw new Error('Cannot rebuild Codex home: same-owner sqlite_home binding is missing');
    return recordedHome || codexSqliteHomeForSessionKey(sessionKey);
  }
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    // A native container can atomically replace this private file under a
    // host-owned directory. Only the exact launch receipt can recover its
    // state binding when the host cannot read it; never guess from TMPDIR.
    const code = (error as NodeJS.ErrnoException).code;
    if (allowUnreadableConfig && recordedHome && (code === 'EACCES' || code === 'EPERM')) return recordedHome;
    throw error;
  }
  if (!/^[ \t]*sqlite_home[ \t]*=/m.test(text)) {
    if (requireExistingBinding) throw new Error('Cannot rebuild Codex home: same-owner sqlite_home binding is missing');
    return recordedHome || codexSqliteHomeForSessionKey(sessionKey);
  }
  let config: ReturnType<typeof parseToml>;
  try {
    config = parseToml(text);
  } catch (error) {
    // A damaged managed table/tail must not prevent repair of an intact root
    // binding. Parse the entire root block, never regex-extract a guessed path
    // or fall back to the current serving environment. A malformed root still
    // fails closed, including duplicate/invalid sqlite_home assignments.
    const firstTable = text.search(/^[ \t]*\[/m);
    if (firstTable < 0) throw error;
    config = parseToml(text.slice(0, firstTable));
  }
  const sqliteHome = config.sqlite_home;
  if (typeof sqliteHome !== 'string' || !isAbsolute(sqliteHome) || sqliteHome.includes('\0')) {
    throw new Error('Cannot repair Codex home: recorded sqlite_home must be an absolute path');
  }
  if (recordedHome && recordedHome !== sqliteHome &&
      !verifiedRetainedCodexSqliteHome(codexHome, sessionKey, recordedHome, sqliteHome, sid)) {
    throw new Error('Cannot repair Codex home: launch receipt and configured sqlite_home disagree');
  }
  return sqliteHome;
}

/** The system skills root Codex reads. Creating it needs root, so host setup provisions it. */
export const CODEX_SYSTEM_SKILLS_DIR = '/etc/codex/skills';

export interface CodexSkillWatchRoots {
  /** `<CODEX_HOME>/skills` — a symlink to ~/.codex/skills when that exists, else an empty dir. */
  codexHomeSkillsDir: string;
  codexHomeSkillsReady: boolean;
  /** `~/.agents/skills` — user-writable, created here. */
  userSkillsDir: string;
  userSkillsReady: boolean;
  /** `/etc/codex/skills` — only reported; a missing one makes every Codex session watch /etc. */
  systemSkillsDir: string;
  systemSkillsReady: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * EI-21417256075155406 (measured 2026-10-01, codex-cli 0.159.3): Codex's skills watcher
 * watches each skills root, and for a MISSING root it watches the nearest existing ancestor
 * with an inotify mask that includes IN_OPEN. A missing /etc/codex/skills therefore puts a
 * watch on /etc, and every process start anywhere on the host (each opens /etc/ld.so.cache)
 * wakes every Codex session; a missing ~/.agents/skills or <CODEX_HOME>/skills does the same
 * for $HOME / the busy Codex home. On a 128-core agent host this held idle sessions at
 * ~1/3 core each; creating the roots dropped them to ~0.1%. Creating the roots as empty
 * directories pins the watches onto quiet directories. Best-effort and never throws.
 */
export function ensureCodexSkillWatchRoots(
  opts: { codexHome?: string; home?: string; systemSkillsDir?: string } = {},
): CodexSkillWatchRoots {
  const codexHomeSkillsDir = join(opts.codexHome ?? join(opts.home ?? homedir(), '.codex'), 'skills');
  const userSkillsDir = join(opts.home ?? homedir(), '.agents', 'skills');
  const systemSkillsDir = opts.systemSkillsDir ?? CODEX_SYSTEM_SKILLS_DIR;
  for (const dir of [codexHomeSkillsDir, userSkillsDir]) {
    if (isDirectory(dir)) continue;
    try {
      // A dangling inherited symlink would make mkdir fail; replace it with a real dir.
      if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(dir);
      mkdirSync(dir, { recursive: true });
    } catch {
      /* reported below as not ready */
    }
  }
  return {
    codexHomeSkillsDir,
    codexHomeSkillsReady: isDirectory(codexHomeSkillsDir),
    userSkillsDir,
    userSkillsReady: isDirectory(userSkillsDir),
    systemSkillsDir,
    systemSkillsReady: isDirectory(systemSkillsDir),
  };
}

/** EI-11366: the sid `writeSuCodexHome` last stamped at this codexHome path
 *  (its `.owner-sid` sentinel), or null when absent/unreadable — an old home
 *  written before this guard existed, a `writeRoleCodexHome` home (no
 *  sentinel), or a path that doesn't exist yet. Pure fs read, never throws. */
function existingCodexHomeOwnerSid(codexHome: string): string | null {
  try {
    const p = join(codexHome, '.owner-sid');
    if (!existsSync(p)) return null;
    const v = readFileSync(p, 'utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function existingCodexHomeOwnerSidAsync(codexHome: string): Promise<string | null> {
  try {
    const value = (await readFile(join(codexHome, '.owner-sid'), 'utf8')).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const codexHomeAsyncWriteTails = new Map<string, Promise<void>>();

/** Serialize async home mutations across their sentinel read/write boundary. */
async function withCodexHomeAsyncWriteLock<T>(codexHome: string, action: () => Promise<T>): Promise<T> {
  const previous = codexHomeAsyncWriteTails.get(codexHome) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  codexHomeAsyncWriteTails.set(codexHome, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (codexHomeAsyncWriteTails.get(codexHome) === tail) codexHomeAsyncWriteTails.delete(codexHome);
  }
}

async function stampCodexHomeOwnerSidAsync(codexHome: string, sid: string): Promise<void> {
  try {
    await (await import('node:fs/promises')).writeFile(join(codexHome, '.owner-sid'), sid, { mode: 0o600 });
  } catch {
    /* non-fatal: the collision guard simply skips on the next write */
  }
}

/** Async preflight for bootstrap callers: keep the psu-host liveness probe off
 *  the operator event loop before the synchronous home materialization begins. */
export async function assertSuCodexHomeNotOwnedByLiveSession(
  sessionKey: string | number,
  sid: string,
  isOwnerLive: (ownerSid: string) => Promise<boolean>,
): Promise<void> {
  let priorSid: string | null = null;
  try {
    priorSid = (await readFile(join(codexHomeForSessionKey(sessionKey), '.owner-sid'), 'utf8')).trim() || null;
  } catch {
    return;
  }
  if (priorSid && priorSid !== sid && (await isOwnerLive(priorSid))) {
    throw new Error(
      `writeSuCodexHome: refusing to rebuild a live Codex home owned by a different session ` +
        `(owner ${priorSid}); overwriting it would silently split that session's identity ` +
        `(EI-11366). Pass the same sid to re-prepare that session, or use a sessionKey that ` +
        `does not collide with a live session's home.`,
    );
  }
}

/** Normalize a session key to the numeric adv_sessions id used by Codex homes.
 * Temporary session-port keys are UUIDs and must not be baked into lifecycle
 * hooks as if they were durable row ids. */
function numericAdvSessionId(value: string | number | null | undefined): string | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

/**
 * Move an already-materialized isolated Codex home from a temporary launch
 * key to the durable adv-session id used by every native resume path.
 *
 * Session ports deliberately create all fallible launch artifacts before
 * recording their pending target row. Once that row exists, the home must be
 * re-keyed instead of rebuilt: rebuilding would discard prompts/hooks already
 * materialized into the home, while leaving it under the port UUID makes
 * `psu --resume=<adv id>` look in a different directory. Refuse to overwrite a
 * destination so this helper can never erase another session's native state.
 */
export function rekeyCodexHome(sourceSessionKey: string | number, targetSessionKey: string | number): string {
  const source = codexHomeForSessionKey(sourceSessionKey);
  const target = codexHomeForSessionKey(targetSessionKey);
  const sourceSqlite = codexSqliteHomeForSessionKey(sourceSessionKey);
  const targetSqlite = codexSqliteHomeForSessionKey(targetSessionKey);
  if (source === target) return target;
  if (!existsSync(source)) throw new Error(`temporary Codex home does not exist: ${source}`);
  if (existsSync(target)) throw new Error(`target Codex home already exists: ${target}`);
  if (existsSync(targetSqlite)) throw new Error(`target Codex sqlite home already exists: ${targetSqlite}`);
  const movedSqlite = existsSync(sourceSqlite);
  if (movedSqlite) renameSync(sourceSqlite, targetSqlite);
  try {
    renameSync(source, target);
  } catch (error) {
    if (movedSqlite) renameSync(targetSqlite, sourceSqlite);
    throw error;
  }
  const configPath = join(target, 'config.toml');
  try {
    const config = readFileSync(configPath, 'utf8');
    const next = config.replace(
      `sqlite_home = "${tomlEscape(sourceSqlite)}"`,
      `sqlite_home = "${tomlEscape(targetSqlite)}"`,
    );
    if (next !== config) publishCodexConfig(configPath, next);
  } catch {
    // The normal launch path writes this file before rekey. If a legacy home
    // lacks it, the resume repair path renders the canonical target path.
  }
  return target;
}

const CODEX_HOME_INHERIT_DIRS = ['skills', 'plugins', 'prompts'] as const;
const CODEX_HOME_INHERIT_FILES = ['auth.json'] as const;

/**
 * Carry user-installed Codex capabilities into an isolated per-session home
 * without copying volatile session state. Symlinks are intentional: auth token
 * rotation and skill/plugin updates stay live, and the per-session home remains
 * small enough to recreate every launch.
 */
function inheritUserCodexHome(codexHome: string): void {
  const realHome = join(homedir(), '.codex');
  try {
    if (!existsSync(realHome)) return;
    for (const name of CODEX_HOME_INHERIT_FILES) {
      const src = join(realHome, name);
      const dst = join(codexHome, name);
      if (existsSync(src)) symlinkSync(src, dst);
    }
    for (const name of CODEX_HOME_INHERIT_DIRS) {
      const src = join(realHome, name);
      const dst = join(codexHome, name);
      if (existsSync(src) && lstatSync(src).isDirectory()) symlinkSync(src, dst, 'dir');
    }
  } catch {
    /* best-effort — codex surfaces missing auth/config issues itself */
  }
}

/**
 * tui-status-parity-single-source-2026-07-05 follow-up (live-window verify):
 * codex's TUI writes its OWN OSC-0 terminal title every turn (default items
 * `["activity","project"]`), which CLOBBERS the display.title our
 * posttooluse-objective-title.sh hook writes — verified live 2026-07-05: a
 * hook/manual title was reset to the project name within one turn. An EMPTY
 * `tui.terminal_title` item list stops codex writing titles entirely
 * (verified: a pre-set sentinel title survived boot + a full turn), so the
 * hook owns the title — same single-source display.title as claude/omp.
 */
// codex `[tui]` table. One emission point (TOML forbids duplicate
// table headers):
//  - terminal_title = [] — the objective-title hook owns the title
//    (single-source display.title); an empty item list stops codex writing its
//    OWN OSC-0 title each turn (see the doc comment above).
//  - alternate_screen = "never" — Codex 0.157 enables mouse reporting in its
//    alternate screen. GNOME Terminal then sends right-clicks to Codex instead
//    of opening the Paste context menu. Keeping normal scrollback also keeps
//    the terminal's right-click menu usable (WI-10003121).
//  - status_line — gives codex a native BOTTOM status pane (tui-status-parity
//    stopgap D, 2026-07-06). codex 0.142.5 has NO command-backed status item
//    (openai/codex#17827 is unmerged) so we can't render the papercusp fleet
//    chips here — these are codex's OWN native items instead: run-state
//    (Ready/Working/Thinking) · model+reasoning · context% remaining · git
//    branch. All are canonical rust-v0.142.5 StatusLineItem IDs; an unknown id
//    only warns-once + is ignored (codex `doctor` validates TOML structure, not
//    item membership), so a bad id can never break boot. NOT true fleet parity
//    — that needs the upstream command-item PR (B).
const CODEX_TUI_TOML = [
  '# The papercusp objective-title hook owns the terminal title (coord:glance',
  '# display.title); an empty item list stops codex clobbering it each turn.',
  '# status_line: a native bottom status pane (codex-own items — codex 0.142 has',
  '# no command-backed status item, openai/codex#17827; stopgap, not fleet chips).',
  '[tui]',
  'terminal_title = []',
  'alternate_screen = "never"',
  'status_line = ["run-state", "model-with-reasoning", "context-remaining", "git-branch"]',
  '',
] as const;

// WI-3278: bake the approvals/sandbox bypass into config.toml so it survives any
// codex relaunch that drops the CLI flags (the claude twin lost its ENTIRE argv
// to a 2.1.20x self-re-exec on the Windows VM — same argv-proofing here). The
// launcher's --dangerously-bypass-approvals-and-sandbox stays as the fast path.
// ROOT-LEVEL keys — must be emitted before the first [table] header.
const CODEX_DANGER_TOML = [
  '# psu/role sessions run with full approvals/sandbox bypass (owner mandate:',
  '# psu-launched agents get the most dangerous permissions — WI-3278). Config-',
  '# level so the grant survives a relaunch that drops the CLI flags.',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
] as const;

/** Trust state for the generated home's config.toml.
 *
 *  Two sources, one emission point (TOML forbids duplicate table headers):
 *  1. INHERITED — the user's real ~/.codex/config.toml trust tables. Modern
 *     codex records directory trust as `[projects."<path>"] trust_level`
 *     (ProjectConfig); `[trusted_workspaces]` is the legacy shape we used to
 *     inherit EXCLUSIVELY — which silently became a no-op once codex moved to
 *     `projects.*`, so every fresh per-session home booted untrusted and the
 *     TUI blocked on "Do you trust the contents of this directory?"
 *     (live-caught 2026-07-05, psu codex session-10753).
 *     The SAME failure class recurred 2026-08-09 one prompt over: a fresh home
 *     carries no `[tui.model_availability_nux]` state, so codex fires its
 *     model-availability nudge ("Switch to <newer model>? / Keep current /
 *     never show again") and blocks the TUI on it. That is merely annoying in a
 *     visible terminal and FATAL headless, where the launch hands codex
 *     fd0=/dev/null: the modal can never be answered, so the session wedges
 *     forever while staying ALIVE — burning a slot, emitting nothing, detected
 *     by no watchdog (EI-19988517595776254). Inheriting the nudge state carries
 *     the user's existing dismissals forward, which is why that table is kept.
 *     ⚠ This REDUCES recurrence; it does not cure it. A nudge for a model the
 *     user has never been offered has no inherited entry to carry, and any
 *     FUTURE codex modal wedges headless the same way. The structural fix is a
 *     headless codex that cannot block on a modal (or that dies loudly instead
 *     of hanging); until then, prefer a VISIBLE launch when the session must be
 *     trusted to make progress.
 *  2. SEEDED — `trustDir`, the directory the operator is launching the agent
 *     into. A psu/role launch is trusted by definition (the launcher already
 *     passes --dangerously-bypass-hook-trust + YOLO permissions), and a fresh
 *     CODEX_HOME never carries an answer forward — without the seed, every
 *     scripted codex launch hangs at the trust prompt.
 */
function inheritedCodexTrustToml(trustDir?: string | null, inheritAmbientContext = true): string[] {
  const source = join(homedir(), '.codex', 'config.toml');
  const out: string[] = [];
  if (inheritAmbientContext && existsSync(source)) {
    let keep = false;
    for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        keep =
          table[1] === 'trusted_workspaces' ||
          table[1].startsWith('trusted_workspaces.') ||
          table[1] === 'projects' ||
          table[1].startsWith('projects.') ||
          // Nudge-dismissal state — see the model-availability note above.
          table[1] === 'tui.model_availability_nux' ||
          table[1].startsWith('tui.model_availability_nux.') ||
          // EI-19988517595776254 follow-up: `[notice]` carries the SAME class of
          // interactive-nudge suppression as model_availability_nux (e.g.
          // `hide_rate_limit_model_nudge = true`, `hide_gpt5_1_migration_prompt =
          // true`) — a separate TUI notice family that can equally block a
          // headless session's unanswerable fd0=/dev/null modal. `[notice.
          // model_migrations]` is the deprecated->replacement model map codex
          // consults when deciding whether to show the migration prompt at all,
          // so it travels with the hide_* flags rather than being left to default.
          // Inheriting whatever the user's real ~/.codex/config.toml already has
          // set (opt-in only — nothing is forced true here) further reduces, but
          // — like model_availability_nux — does not by itself cure, the class of
          // wedge this whole function exists to mitigate.
          table[1] === 'notice' ||
          table[1].startsWith('notice.');
      }
      if (keep) out.push(line);
    }
  }
  const inherited = out.length > 0 ? ['# Inherited trust state from ~/.codex/config.toml.', ...out, ''] : [];
  if (trustDir) {
    // Codex looks up the normalized cwd exactly. A harness projectDir may end
    // in '/', which otherwise creates an unused trust entry and blocks workers
    // at the interactive folder-trust prompt.
    const header = `[projects."${tomlEscape(resolve(trustDir))}"]`;
    const alreadyInherited = inherited.some((l) => l.trim() === header);
    if (!alreadyInherited) {
      inherited.push(
        '# Launch-dir trust seeded by the operator (a psu/role launch is trusted by',
        '# definition) — a fresh CODEX_HOME otherwise blocks on the trust prompt.',
        header,
        'trust_level = "trusted"',
        '',
      );
    }
  }
  return inherited;
}

function copyInheritedCodexPrompts(codexHome: string): boolean {
  const prompts = join(codexHome, 'prompts');
  if (!existsSync(prompts)) return false;
  try {
    if (lstatSync(prompts).isSymbolicLink()) {
      const managed = join(codexHome, 'prompts.user');
      unlinkSync(prompts);
      cpSync(join(homedir(), '.codex', 'prompts'), managed, { recursive: true, force: true, dereference: true });
      symlinkSync(managed, prompts, 'dir');
      return true;
    }
  } catch {
    /* saved-prompt materialization can recreate prompts if inheritance fails */
  }
  return false;
}

/**
 * Write a fresh `hooks.json` into a per-session CODEX_HOME carrying the managed
 * SU hooks (locks, content integrity, activity, lifecycle, and injection). The
 * home is recreated each launch, so there is nothing to merge. No-op
 * (returns false) when the shared hook scripts aren't installed at
 * `~/.papercusp/hooks/cc/`. The launcher must exec codex with
 * `--dangerously-bypass-hook-trust` (the only hooks here are ours).
 *
 * FILE NAME (D-010): codex discovers hooks at `$CODEX_HOME/hooks.json` or
 * `config.toml [[hooks.PreToolUse]]` — NOT `settings.json` (the Claude path
 * the installer §4f + an earlier version of this wrote, which codex silently
 * ignored). We write `hooks.json`.
 *
 * ⚠ CORRECTED 2026-08-09 (codex-context-injection-parity-2026-08-09 D-004).
 * This comment used to read: "codex fires ONLY PreToolUse/PostToolUse — no
 * UserPromptSubmit-equivalent event exists in its hooks.json". That is FALSE
 * and was load-bearing for two plans. MEASURED, live, codex-cli 0.146.0: a
 * `$CODEX_HOME/hooks.json` carrying a `UserPromptSubmit` MatcherGroup FIRES —
 * codex's own log prints `hook: UserPromptSubmit` / `... Completed` and the
 * hook's stdin carries { prompt, cwd, session_id, turn_id, model, ... }.
 * The turn-start port is therefore REACHABLE on codex via THIS file.
 *
 * TURN PROVENANCE + OWNER-DIRECTIVE CAPTURE: Codex's UserPromptSubmit hook
 * carries the same prompt/session/turn identity the shared provenance script
 * needs. Register that script beside the context-injection dispatcher below;
 * it verifies Papercusp's nonce ledger, stamps the turn, and captures only an
 * interactive owner prompt. Keep both entries behind the session identity and
 * the provenance script's installed-file check.
 *
 * ⚠ TRUST IS SILENT (D-004, measured): an UNTRUSTED codex hook does not fire
 * and does not warn — no error, no log line, exit 0, session otherwise normal.
 * Every hook registered here therefore depends on the launcher passing
 * `--dangerously-bypass-hook-trust` (psu-launcher.mjs does, on all four codex
 * paths). If that flag is ever dropped, EVERY hook in this file — locks,
 * activity, objective-title AND injection — silently stops, with no signal.
 * That is precisely the failure class the P-005 injection-coverage detector
 * exists to catch; keep them wired together.
 *
 * LOCK HOOKS: current Codex discovers this per-session `hooks.json` and fires
 * PreToolUse/PostToolUse for `apply_patch` (plus the Edit/Write aliases) and
 * shell/MCP tool names. The launcher passes `--dangerously-bypass-hook-trust`
 * because this home contains only Papercusp-managed hooks.
 *
 * ACTIVITY HOOK (su + role), COORD-FOLDING for SU — NOT inert when
 * `activitySid` is given. The codex leg of the cross-CLI ACTIVITY BRIDGE
 * (papercusp-worker-integration-2026-06-04, D-002/D-003): every PostToolUse
 * mirrors the worker's native tool call into harness_shared.agent_activity →
 * the pui fleet view + curator. codex's PostToolUse fires for edits + Bash +
 * MCP, so this is reliable on codex. We BAKE PAPERCUSP_SID=<activitySid> +
 * PAPERCUSP_AGENT=codex because codex hands hooks a minimal env (the same
 * reason the lock hooks bake their values). Fires for BOTH su AND role
 * sessions — role sessions ARE workers, so their activity belongs in the
 * fleet view.
 *
 * Since EI-11405 (coordination-hook-rpc-fanout-collapse-2026-07-16) this SAME
 * hook ALSO carries the coord:inbox PUSH that used to be a separate
 * posttooluse-coord-inbox.sh entry: the script sends a delta-aware
 * `hook_bundle` cursor on `activity:report` and folds any NEW coord:inbox
 * messages into the SAME response (packages/operator-core/lib/agent-tools/
 * activity/hook-bundle.ts) — one round trip instead of two, mid-turn delivery
 * parity with the Claude global-settings coord entry. When `coordSid` is
 * given (SU sessions only) the fold stays ON (the script's default). Role
 * sessions get NO coord fold — they coordinate via messages:feature_*, not
 * the SU coord bus — so a role-only registration (activitySid without
 * coordSid) bakes PAPERCUSP_COORD_FOLD=0, which keeps that session on the
 * original detached, zero-added-latency report-only path (no hook_bundle
 * built, no synchronous wait).
 *
 * OBJECTIVE-TITLE HOOK (su + role) — NOT inert when `objectiveSid` is given. The
 * codex leg of the SESSION-OBJECTIVE DISPLAY (session-objective-display-2026-06-22,
 * P-003): codex has no statusline, but it owns a tty, so each PostToolUse sets the
 * terminal TITLE to this session's `coord:glance` self.objective via an OSC-0
 * escape — the same objective the Claude statusline renders as its leading 🔭
 * segment. Fires for su AND role (both want their tab/window title to say what
 * they're doing). PAPERCUSP_SID=<objectiveSid> is baked (codex's minimal hook env).
 *
 * LIFECYCLE HOOK (su + role) — Codex 0.149 exposes SessionStart/SessionEnd in
 * hooks.json, but the managed home used to omit both. That made an owner-visible
 * "end session" invisible to Papercusp: no lifecycle row, no lease cleanup, and
 * — most importantly — no handoff to the managed-host teardown path, so `psu
 * --resume` correctly found the old host still alive and refused a double host.
 * Register the SAME lifecycle-report.sh used by Claude. Stop also replays
 * uncaught per-edit lock releases before a carry/turn boundary can strand them.
 * SessionEnd runs synchronously because the script first asks activity:report whether this is a
 * genuine terminal end or a carry/reset continuation, then reuses the audited
 * admin fleet:kill route only for the terminal verdict (WI-41305).
 */
export function writeCodexLockHooks(
  codexHome: string,
  opts: {
    lockSid?: string;
    coordSid?: string;
    activitySid?: string;
    /** Durable adv_sessions row id for exact lifecycle re-anchors. */
    advSessionId?: string | number;
    /** Exact initial headless task id, scoped to lifecycle hook commands only. */
    agentTaskId?: string | null;
    objectiveSid?: string;
    /** codex-context-injection-parity-2026-08-09 P-004: session id baked into
     *  the context-injection dispatcher invocation. Absent ⇒ no injection hooks
     *  (the dispatcher's own invariant 3 would exit 0 silently anyway). */
    injectSid?: string;
    agentSession?: boolean;
    headless?: boolean;
    /** Exact per-session MCP URL. The managed PreCompact hook reuses this
     * route verbatim so role/workspace/harness/signature boundaries survive. */
    mcpUrl?: string;
    /** Superuser homes authenticate with the same on-disk bearer as their MCP
     * config; role homes keep their signed no-bearer route. */
    mcpUsesSuperuserToken?: boolean;
  } = {},
): boolean {
  const dir = installedHookPath('cc');
  const pre = join(dir, 'pretooluse-locks-acquire.sh');
  const post = join(dir, 'posttooluse-locks-release.sh');
  if (!existsSync(pre) || !existsSync(post)) return false;
  const root = shellSingleQuote(resolveWorkspaceRoot());
  const headless = opts.headless ?? process.env.PAPERCUSP_PSU_HEADLESS === '1';
  // Codex gives hook commands a minimal/stale environment. The lock hooks MUST
  // use the exact same per-session owner as the MCP URL; otherwise an explicit
  // multi-file claim by this session blocks its own automatic per-edit acquire.
  const lockIdentity = opts.lockSid
    ? ` PAPERCUSP_LOCK_SID=${shellSingleQuote(opts.lockSid)} PAPERCUSP_SID=${shellSingleQuote(opts.lockSid)}`
    : '';

  type CodexHook = {
    matcher: string;
    hooks: { type: 'command'; command: string; timeout?: number }[];
  };
  const postToolUse: CodexHook[] = [
    {
      matcher: CODEX_LOCK_POST_MATCHER,
      hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root}${lockIdentity} ${post}` }],
    },
  ];

  // EI-21220966892195714: full writes are the only edit shape whose input
  // contains enough content for an exact post-write byte comparison. Keep this
  // separate from the lock-release matcher so apply_patch/parent exec calls do
  // not invoke a guard that cannot reconstruct their resulting file.
  const writeByteIntegrity = join(dir, 'posttooluse-write-byte-integrity-guard.mjs');
  if (existsSync(writeByteIntegrity)) {
    postToolUse.push({
      matcher: CODEX_WRITE_BYTE_INTEGRITY_MATCHER,
      hooks: [{ type: 'command', command: writeByteIntegrity }],
    });
  }

  const launchProseNudge = join(dir, 'posttooluse-launch-prose-budget-nudge.mjs');
  if (existsSync(launchProseNudge)) {
    postToolUse.push({
      matcher: '^(?:Edit|Write|MultiEdit|apply_patch|write_file|edit_file|Bash|exec_command|shell_command|(?:mcp__.*__)?capability[:_-](?:edit|write|multi_?edit|patch|bash)|(?:mcp__.*__)?tools[:_]invoke)$',
      hooks: [{ type: 'command', command: launchProseNudge, timeout: 60 }],
    });
  }

  // Activity-bridge hook (matcher `.*`), coord-folding when `coordSid` is ALSO
  // given (SU sessions only — see the header doc for the EI-11405 merge).
  // Baked PAPERCUSP_SID = the session's identity (the activity owner/pane key
  // AND the coord identity when folding) + PAPERCUSP_AGENT=codex.
  const activity = join(dir, 'posttooluse-activity-report.sh');
  if (opts.activitySid && existsSync(activity)) {
    const coordFold = opts.coordSid ? '' : ' PAPERCUSP_COORD_FOLD=0';
    postToolUse.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT=codex PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)}${coordFold} ${activity}`,
        },
      ],
    });
  }

  // Objective-title hook (matcher `.*`): set the terminal title to this session's
  // coord:glance self.objective (session-objective-display-2026-06-22). Baked
  // PAPERCUSP_SID = the session's coord identity (the glance read keys off it).
  const objective = join(dir, 'posttooluse-objective-title.sh');
  if (opts.objectiveSid && existsSync(objective)) {
    postToolUse.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_SID=${shellSingleQuote(opts.objectiveSid)} ${objective}`,
        },
      ],
    });
  }

  const lifecycle = join(dir, 'lifecycle-report.sh');
  const sessionStart: CodexHook[] = [];
  const sessionEnd: CodexHook[] = [];
  const lifecycleStop: CodexHook[] = [];
  if (opts.activitySid && existsSync(lifecycle)) {
    let lifecycleIdentity =
      `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT=codex ` +
      `PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)}` +
      (numericAdvSessionId(opts.advSessionId)
        ? ` PAPERCUSP_ADV_SESSION_ID=${shellSingleQuote(numericAdvSessionId(opts.advSessionId)!)}`
        : '');
    const lifecycleTaskId =
      typeof opts.agentTaskId === 'string' && /^[0-9a-z]{19}$/.test(opts.agentTaskId)
        ? opts.agentTaskId
        : null;
    if (lifecycleTaskId) {
      lifecycleIdentity += ' PAPERCUSP_AGENT_TASK_ID=' + shellSingleQuote(lifecycleTaskId);
    }
    sessionStart.push({
      matcher: '.*',
      hooks: [{ type: 'command', command: `${lifecycleIdentity} ${lifecycle}` }],
    });
    sessionEnd.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${lifecycleIdentity} PAPERCUSP_ACTIVITY_SYNC=1 ${lifecycle}`,
        },
      ],
    });
    lifecycleStop.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${lifecycleIdentity} PAPERCUSP_ACTIVITY_SYNC=1 ${lifecycle}`,
        },
      ],
    });
  }

  // CONTEXT-INJECTION hooks (codex-context-injection-parity-2026-08-09 P-004).
  // Both ports go through the ONE shared dispatcher (D-001) — never a codex-
  // specific copy of the transport. The dispatcher is installed BESIDE the cc
  // hooks at ~/.papercusp/hooks/inject/ (installInjectionHooks in
  // desktop-install/papercusp-files.ts), so it is gated on its OWN existence,
  // not on the cc lock-hook gate above.
  //
  // PAPERCUSP_SID IS BAKED, and that is load-bearing: codex hands hook commands
  // a minimal env, and the dispatcher treats a missing PAPERCUSP_SID as "not a
  // psu session" and exits 0 with no output (D-001 invariant 3). An un-baked
  // sid would therefore produce a hook that runs, succeeds, and injects nothing
  // — indistinguishable from a hook that never fired.
  //
  // EVENT NAMES: PascalCase, matching the payload's own hook_event_name and the
  // codex adapter's portForEvent. UserPromptSubmit -> turn-start,
  // PostToolUse -> mid-turn (PER CALL on codex — it has no batch event; D-002
  // §5 explains why the frozen array interface absorbs that).
  const injectDispatcher = installedHookPath('inject', 'index.mjs');
  const userPromptSubmit: CodexHook[] = [];
  const provenance = join(dir, 'userpromptsubmit-provenance.sh');
  if (opts.injectSid && existsSync(provenance)) {
    userPromptSubmit.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_SID=${shellSingleQuote(opts.injectSid)} PAPERCUSP_AGENT=codex ${provenance}`,
        },
      ],
    });
  }
  if (opts.injectSid && existsSync(injectDispatcher)) {
    const injectIdentity = `PAPERCUSP_SID=${shellSingleQuote(opts.injectSid)} PAPERCUSP_AGENT=codex`;
    userPromptSubmit.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${injectIdentity} ${injectDispatcher} --client=codex --event=UserPromptSubmit`,
        },
      ],
    });
    postToolUse.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${injectIdentity} ${injectDispatcher} --client=codex --event=PostToolUse`,
        },
      ],
    });
  }

  // managed-carry-lifecycle-enforcement P-002: Codex native AUTO compaction
  // bypasses the deterministic carry/checkpoint/lifecycle path. Official Codex
  // PreCompact semantics make this the synchronous veto seam: the hook asks the
  // existing session:request-compaction tool to queue the managed boundary and
  // returns continue:false regardless of outcome, so a refusal/transport fault
  // leaves the current session intact instead of falling through to native
  // compaction. Use the exact MCP route already baked into config.toml — role
  // signatures and SU authority must not be widened by the hook.
  const preCompact: CodexHook[] = [];
  const managedPreCompact = join(dir, 'precompact-managed-carry.mjs');
  if (opts.activitySid && opts.mcpUrl && existsSync(managedPreCompact)) {
    let harnessSlug = '';
    try {
      harnessSlug = new URL(opts.mcpUrl).searchParams.get('harness')?.trim() ?? '';
    } catch {
      /* the existing config writer/test owns URL validation; empty is diagnostic only */
    }
    const identity =
      `PAPERCUSP_MCP_URL=${shellSingleQuote(opts.mcpUrl)} ` +
      `PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)} ` +
      `PAPERCUSP_HARNESS_SLUG=${shellSingleQuote(harnessSlug)}` +
      (opts.mcpUsesSuperuserToken ? ' PAPERCUSP_MCP_AUTH=superuser-token' : '');
    preCompact.push({
      matcher: '^auto$',
      hooks: [
        {
          type: 'command',
          command: `${identity} ${managedPreCompact}`,
          timeout: 600,
        },
      ],
    });
  }

  const preToolUse: CodexHook[] = [
    {
      matcher: CODEX_LOCK_PRE_MATCHER,
      hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root}${lockIdentity} ${pre}` }],
    },
  ];

  // EI-18801362747285637: Claude already installed this guard globally, but
  // managed Codex homes carried only the lock hook. A Codex apply_patch could
  // therefore commit raw control bytes and first learn about them at the green
  // gate. Reuse the SAME policy-bearing script; it parses apply_patch added lines
  // and deliberately ignores deleted/context lines so repairing a dirty file is
  // never blocked by the byte being removed.
  const controlBytes = join(dir, 'pretooluse-control-bytes-content-guard.mjs');
  if (existsSync(controlBytes)) {
    preToolUse.push({
      matcher: CODEX_CONTROL_BYTES_PRE_MATCHER,
      hooks: [{ type: 'command', command: controlBytes }],
    });
  }

  // WI-41770: keep the policy-bearing generated-artifact guard identical across
  // Claude and managed Codex homes. The shared script understands Codex's raw or
  // wrapped apply_patch frame, so projected docs cannot be hand-edited through a
  // client whose tool payload has no top-level file_path.
  const generatedFiles = join(dir, 'pretooluse-generated-file-edit-guard.mjs');
  if (existsSync(generatedFiles)) {
    preToolUse.push({
      matcher: CODEX_CONTROL_BYTES_PRE_MATCHER,
      hooks: [{ type: 'command', command: generatedFiles }],
    });
  }

  // WI-10001350: use the same migration reservation policy for Codex's native
  // apply_patch payloads as the Claude hooks. This shared path matcher accepts
  // apply_patch plus Edit/Write/MCP writer inputs; baking the managed root lets
  // the guard resolve Codex's repository-relative patch targets safely.
  const migrationReservation = join(dir, 'pretooluse-unreserved-migration-guard.mjs');
  if (existsSync(migrationReservation)) {
    preToolUse.push({
      matcher: CODEX_CONTROL_BYTES_PRE_MATCHER,
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} ${migrationReservation}`,
        },
      ],
    });
  }

  // P-010 (fleet-friction-remediation-2026-08-21): an apply_patch envelope may
  // carry at most ONE operation per target path, and violating that rejects the
  // WHOLE patch — deterministically, before anything is written. The class was
  // filed independently five times (EI-21353344120350526, EI-21354846297369687,
  // EI-21565696681975825, EI-21573638140720842, EI-22346861820470210), the last
  // naming the gap exactly: deterministic validation "not surfaced before
  // submission". This is Codex-only by construction — Edit/Write carry a single
  // file_path and cannot express the collision — so it gets its own narrow
  // matcher rather than riding the shared content-guard one.
  const duplicateTarget = join(dir, 'pretooluse-apply-patch-duplicate-target-guard.mjs');
  if (existsSync(duplicateTarget)) {
    preToolUse.push({
      matcher: '^apply_patch$',
      hooks: [{ type: 'command', command: duplicateTarget }],
    });
  }

  // The same local guard as Claude: a headless native dialog cannot be
  // answered from the Inbox's text-reply path. Keep the watcher as a backstop
  // for old homes; new homes deny the dialog before it can park.
  const ownerQuestionGuard = join(dir, 'ask-gate-mirror.sh');
  if (headless && opts.activitySid && existsSync(ownerQuestionGuard)) {
    preToolUse.push({
      matcher: '^(?:functions(?:\\.|__))?request_user_input$',
      hooks: [{
        type: 'command',
        command: `PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)} PAPERCUSP_AGENT=codex PAPERCUSP_PSU_HEADLESS=1 ${ownerQuestionGuard}`,
      }],
    });
  }

  // The shared bash-resource-gate goes on EVERY home, su and role alike, as it
  // does for Claude (~/.claude/settings.json runs it for su sessions with no
  // marker). Its shared-tree git guards (reset --hard, stash, checkout ., the
  // --work-tree index guard) key on the canonical TREE, not on a marker
  // (EI-7872), so they protect the human su too. Until WI-6554700010017981 the
  // su home got no gate at all; a Codex su session then ran
  // `git --work-tree=/tmp/… checkout <sha> -- .` from the shared checkout and
  // staged an old commit over 91 tracked paths of the shared index.
  //
  // Native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010): only
  // AGENT homes (role sessions — never the human su home, D-003) get the agent
  // marker BAKED (codex hands hooks a minimal env, same reason the
  // coord/activity hooks bake PAPERCUSP_SID), so their shell-created OS
  // schedules (crontab/at/batch/systemd-run) are denied and wakes can only live
  // in the harness routines table. The gate's scheduler deny reads that marker.
  const gate = join(dir, CODEX_BASH_GATE_HOOK);
  if (existsSync(gate)) {
    const agentMarker = opts.agentSession ? ' PAPERCUSP_AGENT_SESSION=1' : '';
    preToolUse.push({
      matcher: CODEX_BASH_GATE_MATCHER,
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root}${agentMarker} ${gate}`,
        },
      ],
    });
  }

  // WI-6554700010009447 (owner #1759/#1764): RTK output compression for Codex's
  // native shell, the Codex counterpart of the RTK rewrite inside Claude's
  // egress guard. It must stay the ONLY Codex PreToolUse hook that returns
  // updatedInput: codex resolves competing rewrites by completion order (last
  // to finish wins), and every other hook in this file only denies. Codex
  // applies a rewrite only with permissionDecision "allow", which this script
  // emits; code-mode script calls (tool_use_id `exec-*`) stay verbatim. Su AND
  // role homes, since both run native shells. The script fails open when rtk is
  // missing. role-codex-home.test.ts fails if this registration is removed.
  const rtkRewrite = join(dir, CODEX_RTK_REWRITE_HOOK);
  if (existsSync(rtkRewrite)) {
    preToolUse.push({
      matcher: CODEX_RTK_REWRITE_MATCHER,
      hooks: [{ type: 'command', command: rtkRewrite }],
    });
  }

  // IDENTITY HOOK ports (portable-identity-packages-2026-09-26 P-011, D-023 §2):
  // a worn identity's pre-tool guards, stop rules and compaction rules, through
  // the same dispatcher and the same baked sid as the two context ports above.
  // Every matcher is '.*' — which tools a guard names, and which SessionStart
  // sources mean a fresh context, are decided by the operator and the adapter
  // (codex's schemas are read in adapters/codex.mjs). The guard renders only a
  // deny for the one pending call, so it can never auto-approve (D-027).
  const stop: CodexHook[] = [];

  // WI-10006795: the per-turn JOURNAL hook. stop-turn-journal.sh was written to
  // serve Claude AND Codex (it reads codex's Stop payload — `session_id` plus the
  // nullable `transcript_path` — and keys source_kind off PAPERCUSP_AGENT=codex),
  // but only Claude's settings.json ever enrolled it. Codex sessions therefore
  // never reached journal:record-turn (1 call in 7 days against ~13k for Claude),
  // and a codex GOAL holder emitted no goalPlacementTurnEnd evidence at all.
  // PAPERCUSP_SID is baked for the same reason as every hook above: codex hands
  // hook commands a minimal env, and the script exits 0 silently without it. Its
  // stdout is always empty, so it can never be read as a Stop `decision`.
  //
  // WI-6554700010018765: PAPERCUSP_JOURNAL_SYNC=1 makes the POST finish INSIDE the
  // hook, like every other codex reporting hook (lifecycle Stop/SessionEnd use
  // PAPERCUSP_ACTIVITY_SYNC=1). codex-rs (hooks/src/engine/command_runner.rs,
  // rust-v0.163.0) runs each hook in its own session and kills that process group
  // whenever a run does not complete. The script's detached `( report & )` child
  // stays in that group, so an un-awaited POST died with it: only 3-5% of codex su
  // sessions ever journaled a turn end. The POST is bounded by the script's
  // HTTP_TIMEOUT (5s) and fails open, so a slow operator delays the turn end by at
  // most that.
  const turnJournal = join(dir, CODEX_TURN_JOURNAL_HOOK);
  if (opts.activitySid && existsSync(turnJournal)) {
    stop.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)} PAPERCUSP_AGENT=codex PAPERCUSP_JOURNAL_SYNC=1 ${turnJournal}`,
        },
      ],
    });
  }

  if (opts.injectSid && existsSync(injectDispatcher)) {
    const injectIdentity = `PAPERCUSP_SID=${shellSingleQuote(opts.injectSid)} PAPERCUSP_AGENT=codex`;
    const identityHook = (event: string): CodexHook => ({
      matcher: '.*',
      hooks: [{ type: 'command', command: `${injectIdentity} ${injectDispatcher} --client=codex --event=${event}` }],
    });
    preToolUse.push(identityHook('PreToolUse'));
    stop.push(identityHook('Stop'));
    sessionStart.push(identityHook('SessionStart'));
  }

  // UserPromptSubmit is emitted ONLY when non-empty: an empty MatcherGroup array
  // is meaningless, and a key that is always present would make "is turn-start
  // registered on this home?" un-answerable by reading hooks.json.
  const hooks = {
    hooks: {
      PreToolUse: preToolUse,
      PostToolUse: postToolUse,
      ...(userPromptSubmit.length > 0 ? { UserPromptSubmit: userPromptSubmit } : {}),
      ...(stop.length > 0 || lifecycleStop.length > 0 ? { Stop: [...lifecycleStop, ...stop] } : {}),
      ...(sessionStart.length > 0 ? { SessionStart: sessionStart } : {}),
      ...(sessionEnd.length > 0 ? { SessionEnd: sessionEnd } : {}),
      ...(preCompact.length > 0 ? { PreCompact: preCompact } : {}),
    },
  };
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(hooks, null, 2), { mode: 0o600 });
  return true;
}

function writeCodexHomeDiagnostics(
  codexHome: string,
  opts: {
    hooksInstalled: boolean;
    inheritedPromptsCopied: boolean;
    denyAmbientContext?: boolean;
    lockOwnerSid?: string;
    lockRuntime: CodexLockRuntimeVerdict;
    /** Provenance of the stripped model catalog (non-gateway homes only; plan D-005). */
    modelCatalog?: CodexModelCatalogMaterialized | null;
  },
): void {
  const body = {
    ...(opts.modelCatalog
      ? {
          modelCatalog: {
            source: opts.modelCatalog.source,
            sourcePath: opts.modelCatalog.sourcePath,
            modelCount: opts.modelCatalog.modelCount,
            fetchedAt: opts.modelCatalog.fetchedAt,
            multiAgentFieldsStripped: true,
          },
        }
      : {}),
    // One resolved mode only; coord:orient refreshes the runtime verdict after launch.
    lockEnforcement: opts.hooksInstalled ? 'hooks-configured' : 'hooks-missing',
    codexPreToolUseStatus: opts.lockRuntime.hookHealth,
    lockMode: opts.lockRuntime.lockMode,
    hookHealth: opts.lockRuntime.hookHealth,
    runtimeProbed: opts.lockRuntime.runtimeProbed,
    lockGeneration: opts.lockRuntime.generation,
    lockReason: opts.lockRuntime.reason,
    requiresExplicitPapercuspLocks: opts.lockRuntime.lockMode === 'manual',
    ...(opts.lockOwnerSid ? { lockOwnerSid: opts.lockOwnerSid } : {}),
    inheritedPromptsCopied: opts.inheritedPromptsCopied,
    ...(opts.denyAmbientContext ? { denyAmbientContext: true } : {}),
    // EI-21417256075155406: systemSkillsReady=false means every Codex session on this host
    // watches /etc and wakes on every process start — provision /etc/codex/skills.
    codexSkillWatchRoots: ensureCodexSkillWatchRoots({ codexHome }),
  };
  writeFileSync(join(codexHome, 'papercusp-diagnostics.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Repair only the managed identity files of an EXISTING SU Codex home.
 *
 * A tracked resume intentionally preserves the home's `sessions/**` rollouts,
 * AGENTS.md, auth link, plugins and skills.  It may nevertheless resume that
 * home under a newer coord owner (for example after a cold successor adopts the
 * same adv-session row).  Before EI-211903 the launcher treated any config with
 * an MCP block as "ready", so `config.toml`, hooks.json and diagnostics could
 * keep the prior owner while PAPERCUSP_SID/ptool used the successor.  The lock
 * hook then acquired as the prior owner and reported the successor's deliberate
 * manual lock as foreign contention.
 *
 * This helper is deliberately narrower than `writeSuCodexHome`: it never
 * rebuilds the directory and never touches transcripts or prompts.  It rewrites
 * the canonical hooks, merges the current owner into diagnostics, and advances
 * the collision sentinel.  A same-owner home remains byte-identical.
 */
type CodexHomeOwnerSidIo = { priorSid: string | null; skipStamp?: boolean };

function repairSuCodexHomeIdentityImpl(
  codexHome: string,
  sid: string,
  advSessionId?: string | number,
  mcpUrl?: string,
  ownerSidIo?: CodexHomeOwnerSidIo,
  headless = process.env.PAPERCUSP_PSU_HEADLESS === '1',
): { repaired: boolean; hooksInstalled: boolean; reason?: 'no-home' } {
  if (!existsSync(codexHome)) return { repaired: false, hooksInstalled: false, reason: 'no-home' };

  const diagnosticsPath = join(codexHome, 'papercusp-diagnostics.json');
  const hooksPath = join(codexHome, 'hooks.json');
  let diagnostics: Record<string, unknown> = {};
  let hooksText = '';
  try {
    const parsed = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      diagnostics = parsed as Record<string, unknown>;
    }
  } catch {
    /* missing/malformed is a repair input */
  }
  try {
    hooksText = readFileSync(hooksPath, 'utf8');
  } catch {
    /* missing/unreadable is a repair input */
  }

  const hookOwners = Array.from(hooksText.matchAll(/PAPERCUSP_(?:LOCK_)?SID='([^']+)'/g), (match) => match[1]);
  const hooksExpected = diagnostics.lockEnforcement === 'hooks-configured' || existsSync(hooksPath);
  const expectedAdvSessionId = numericAdvSessionId(advSessionId);
  const hooksMatch = hooksExpected
    ? hookOwners.length > 0 && hookOwners.every((owner) => owner === sid)
    : hookOwners.length === 0;
  const hookWorkspaceMatches = (() => {
    if (!hooksExpected) return true;
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const expected = `PAPERCUSP_WORKSPACE_ROOT=${shellSingleQuote(resolveWorkspaceRoot())}`;
      return [
        ['PreToolUse', 'pretooluse-locks-acquire.sh'],
        ['PostToolUse', 'posttooluse-locks-release.sh'],
      ].every(([event, script]) => parsed.hooks?.[event]?.some((group) =>
        group.hooks?.some((hook) => hook.command?.includes(script) && hook.command.includes(expected)),
      ) === true);
    } catch {
      return false;
    }
  })();
  const diagnosticsMatch = diagnostics.lockOwnerSid === sid;
  const priorSid = ownerSidIo ? ownerSidIo.priorSid : existingCodexHomeOwnerSid(codexHome);
  const sentinelMatches = priorSid === sid;
  const lifecycleHooksMatch = (() => {
    if (!hooksExpected) return true;
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      return ['SessionStart', 'SessionEnd', 'Stop'].every((event) =>
        parsed.hooks?.[event]?.some((group) =>
          group.hooks?.some(
            (hook) =>
              hook.command?.includes('lifecycle-report.sh') &&
              hook.command.includes(`PAPERCUSP_SID='${sid}'`) &&
              (!expectedAdvSessionId || hook.command.includes(`PAPERCUSP_ADV_SESSION_ID='${expectedAdvSessionId}'`)),
          ),
        ),
      );
    } catch {
      return false;
    }
  })();
  const preCompactHookMatches = (() => {
    if (!hooksExpected || !mcpUrl) return true;
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<
          string,
          Array<{
            matcher?: string;
            hooks?: Array<{ command?: string; timeout?: number }>;
          }>
        >;
      };
      return parsed.hooks?.PreCompact?.some(
        (group) =>
          group.matcher === '^auto$' &&
          group.hooks?.some(
            (hook) =>
              hook.timeout === 600 &&
              hook.command?.includes('precompact-managed-carry.mjs') &&
              hook.command.includes(`PAPERCUSP_SID='${sid}'`) &&
              hook.command.includes(`PAPERCUSP_MCP_URL=${shellSingleQuote(mcpUrl)}`) &&
              hook.command.includes('PAPERCUSP_MCP_AUTH=superuser-token'),
          ),
      ) === true;
    } catch {
      return false;
    }
  })();
  // WI-10006795: a home written before the turn-journal enrollment carries a Stop
  // entry with only the identity dispatcher. Without this check the owner-only
  // comparison above calls it current, so a resumed codex session would keep
  // emitting no journal:record-turn rows forever. Gated on the script being
  // installed, exactly like the writer, so a host without it never repair-loops.
  // EI-25438656045891094: old same-owner homes also lack prompt provenance.
  // Without checking enrollment, their genuine owner turns stay unenrolled
  // forever even after the canonical writer gains the hook.
  const managedTurnHooksMatch = (() => {
    if (!hooksExpected) return true;
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      // WI-6554700010018765: a journal entry written before the POST was made
      // synchronous lacks PAPERCUSP_JOURNAL_SYNC=1; Codex kills the hook's process
      // group on a dropped run, so that home must be rewritten on resume too.
      const turnHooks: Array<[event: string, script: string, marker: string | null]> = [
        ['Stop', CODEX_TURN_JOURNAL_HOOK, 'PAPERCUSP_JOURNAL_SYNC=1'],
        ['UserPromptSubmit', 'userpromptsubmit-provenance.sh', null],
      ];
      return turnHooks.every(([event, script, marker]) =>
        !existsSync(installedHookPath('cc', script)) ||
        parsed.hooks?.[event]?.some((group) =>
          group.hooks?.some(
            (hook) =>
              hook.command?.includes(script) &&
              hook.command.includes(`PAPERCUSP_SID='${sid}'`) &&
              hook.command.includes('PAPERCUSP_AGENT=codex') &&
              (marker === null || hook.command.includes(marker)),
          ),
        ) === true,
      );
    } catch {
      return false;
    }
  })();
  // WI-6554700010009447: a home written before the Codex RTK hook existed would
  // otherwise read as current, so a RESUMED su codex session would keep running
  // its shell without RTK. Gated on the script being installed, like the writer.
  const rtkRewriteHookMatches = (() => {
    if (!hooksExpected || !existsSync(installedHookPath('cc', CODEX_RTK_REWRITE_HOOK))) {
      return true;
    }
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      return (
        parsed.hooks?.PreToolUse?.some(
          (group) =>
            group.matcher === CODEX_RTK_REWRITE_MATCHER &&
            group.hooks?.some((hook) => hook.command?.includes(CODEX_RTK_REWRITE_HOOK)),
        ) === true
      );
    } catch {
      return false;
    }
  })();
  // WI-6554700010017981: an su home written before the gate was attached to su
  // homes would otherwise read as current, so a RESUMED codex su session would
  // keep running its shell with no shared-tree guards. The su home must carry
  // the gate WITHOUT the agent marker (D-003). Gated on the script being
  // installed, like the writer, so a host without it never repair-loops.
  const bashGateHookMatches = (() => {
    if (!hooksExpected || !existsSync(installedHookPath('cc', CODEX_BASH_GATE_HOOK))) {
      return true;
    }
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const gates = parsed.hooks?.PreToolUse?.flatMap((g) =>
        g.matcher === CODEX_BASH_GATE_MATCHER ? (g.hooks ?? []) : [],
      ).filter((h) => h.command?.includes(CODEX_BASH_GATE_HOOK)) ?? [];
      return gates.length > 0 && gates.every((h) => !h.command?.includes('PAPERCUSP_AGENT_SESSION'));
    } catch {
      return false;
    }
  })();
  const ownerQuestionGuardMatches = (() => {
    if (!hooksExpected || !existsSync(installedHookPath('cc', 'ask-gate-mirror.sh'))) return true;
    try {
      const parsed = JSON.parse(hooksText) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> } };
      const guards = parsed.hooks?.PreToolUse?.flatMap((g) => g.hooks ?? [])
        .filter((h) => h.command?.includes('ask-gate-mirror.sh')) ?? [];
      return headless
        ? guards.some((h) => h.command?.includes(`PAPERCUSP_SID='${sid}'`) && h.command.includes('PAPERCUSP_PSU_HEADLESS=1'))
        : guards.length === 0;
    } catch { return false; }
  })();
  if (
    hooksMatch &&
    hookWorkspaceMatches &&
    diagnosticsMatch &&
    sentinelMatches &&
    lifecycleHooksMatch &&
    preCompactHookMatches &&
    managedTurnHooksMatch &&
    rtkRewriteHookMatches &&
    bashGateHookMatches &&
    ownerQuestionGuardMatches
  ) {
    return { repaired: false, hooksInstalled: hooksExpected };
  }

  const hooksInstalled = writeCodexLockHooks(codexHome, {
    lockSid: sid,
    coordSid: sid,
    activitySid: sid,
    advSessionId,
    objectiveSid: sid,
    injectSid: sid,
    mcpUrl,
    headless,
    mcpUsesSuperuserToken: true,
  });
  const lockRuntime = readCodexLockRuntimeVerdict({ ownerId: sid, hooksConfigured: hooksInstalled });
  const nextDiagnostics = {
    ...diagnostics,
    lockEnforcement: hooksInstalled ? 'hooks-configured' : 'hooks-missing',
    codexPreToolUseStatus: lockRuntime.hookHealth,
    lockMode: lockRuntime.lockMode,
    hookHealth: lockRuntime.hookHealth,
    runtimeProbed: lockRuntime.runtimeProbed,
    lockGeneration: lockRuntime.generation,
    lockReason: lockRuntime.reason,
    requiresExplicitPapercuspLocks: lockRuntime.lockMode === 'manual',
    lockOwnerSid: sid,
  };
  writeFileSync(diagnosticsPath, `${JSON.stringify(nextDiagnostics, null, 2)}\n`, { mode: 0o600 });
  if (!ownerSidIo?.skipStamp) writeFileSync(join(codexHome, '.owner-sid'), sid, { mode: 0o600 });
  return { repaired: true, hooksInstalled };
}

export function repairSuCodexHomeIdentity(
  codexHome: string,
  sid: string,
  advSessionId?: string | number,
  mcpUrl?: string,
): { repaired: boolean; hooksInstalled: boolean; reason?: 'no-home' } {
  return repairSuCodexHomeIdentityImpl(codexHome, sid, advSessionId, mcpUrl);
}

function codexAgentsPrompt(promptText: string, lockRuntime: CodexLockRuntimeVerdict): string {
  const withoutStaticLockAdvice = promptText.replace(CODEX_LOCK_GUIDANCE_RE, '').replace(/\n{3,}/g, '\n\n');
  return `${withoutStaticLockAdvice.replace(/\n+$/, '')}\n\n${codexLockEnforcementNote(lockRuntime)}`;
}

/**
 * Build (or rebuild) a per-session CODEX_HOME under
 * `~/.papercusp/role-codex-homes/session-<key>`. Idempotent: the dir is
 * recreated fresh each launch so a re-launch can't inherit a stale prompt
 * or url.
 */
export type WriteRoleCodexHomeOptions = {
  capabilityPolicy?: NonNullable<Parameters<typeof codexManagedFeaturesToml>[0]>['capabilityPolicy'];
  sessionKey: string | number;
  /** Exact initial headless task id, scoped to lifecycle hook commands only. */
  agentTaskId?: string | null;
  /** Repair managed files in place without removing the native resume history. */
  preserveExisting?: boolean;
  /** Persisted native-state binding, used when archive/GC removed config.toml. */
  recordedSqliteHome?: string | null;
  /** Already-signed, role-scoped MCP url (from buildRoleLaunchSpec). */
  mcpUrl: string;
  /** The role prompt — becomes AGENTS.md. */
  promptText: string;
  /** Launch model. Extended-window models bake their canonical root keys into
   *  config.toml so a later model-less resume inherits the same window. */
  model?: string | null;
  /** The session's coordination identity (PAPERCUSP_SID = role-<uuid>). Baked
   *  into the activity-bridge hook so this worker's tool calls report under it.
   *  Omit → no activity hook (a role home without an identity). */
  sid?: string;
  /** Optional Codex account pin; writes a custom model provider that points Codex at the inference gateway. */
  codexGatewayAccountId?: string | null;
  /** Route through the gateway with NO pin (explicit-auto, WI-3645): writes the SAME provider
   *  block with the x-papercusp-account header omitted — the gateway auto-selects. Ignored
   *  when codexGatewayAccountId is set. */
  codexGatewayAuto?: boolean;
  /** Admission label written beside the owner header for a gateway-routed role home. */
  codexGatewayPriority?: string | null;
  /** Suppress optional interactive plugin authentication in an unattended TUI. */
  headless?: boolean;
  /** The directory the operator is launching this agent into (spec.cwd). Seeded
   *  as `[projects."<dir>"] trust_level = "trusted"` so a fresh CODEX_HOME does
   *  not block at codex's "Do you trust this directory?" boot prompt. */
  trustDir?: string | null;
};

export function writeRoleCodexHome(opts: WriteRoleCodexHomeOptions): RoleCodexHome {
  // ONE shared codex-home key (unify-launch-mechanics P-004): both role and su
  // codex sessions live under the SAME root the wake-executor resume leg reads
  // (`codexHomeForAdvSession` → `codexHomeForSessionKey`). Previously the role
  // path wrote to a separate `role-codex-homes/` root the resume leg never
  // looked in, so a woken codex role session resumed from nothing.
  const codexHome = opts.preserveExisting
    ? codexHomeForSessionKey(opts.sessionKey)
    : freshCodexHome(codexHomeForSessionKey(opts.sessionKey));
  const sqliteHome = opts.preserveExisting
    ? preservedCodexSqliteHome(codexHome, opts.sessionKey, opts.recordedSqliteHome, false, false, opts.sid)
    : freshCodexSqliteHome(opts.sessionKey);
  if (opts.preserveExisting) {
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
    inheritUserCodexHome(codexHome);
  }
  const inheritedPromptsCopied = copyInheritedCodexPrompts(codexHome);

  // AGENTS.md = the role prompt. codex has no per-launch system-prompt
  // flag; its instruction file is $CODEX_HOME/AGENTS.md (same mechanism
  // codex-su uses for the engineer playbook).
  const agentsPath = join(codexHome, 'AGENTS.md');

  // config.toml: the role-scoped MCP server. The url is already signed
  // (sig-auth), so — unlike the codex-su home — there is no
  // bearer_token_env_var. codex does NOT env-expand config.toml, so the
  // url is baked verbatim.
  const configPath = join(codexHome, 'config.toml');
  const logDir = join(codexHome, 'log');
  mkdirSync(logDir, { recursive: true });
  const gatewayConfig = codexGatewayConfigToml(opts.codexGatewayAccountId, {
    gatewayOn: opts.codexGatewayAuto,
    ownerId: opts.sid,
    priority: opts.codexGatewayPriority,
  });
  // Resolve the model before writing the home.  A missing model MUST become an
  // explicit safe root key; otherwise Codex reads its installed cache on the
  // next model-less resume and can select the denied Spark entry.
  const resolvedModel = resolveCodexModel(opts.model);
  const modelConfig = codexModelConfigToml(resolvedModel);
  const contextConfig = codexContextConfigToml(resolvedModel, { codexHome }).trimEnd();
  const modelCatalog = materializeHomeModelCatalog(codexHome, gatewayConfig.root.length > 0);
  const toml = [
    ...(contextConfig ? contextConfig.split('\n') : []),
    ...modelConfig,
    ...(modelCatalog ? codexModelCatalogToml(modelCatalog.path) : []),
    `sqlite_home = "${tomlEscape(sqliteHome)}"`,
    `log_dir = "${tomlEscape(logDir)}"`,
    ...gatewayConfig.root,
    ...CODEX_DANGER_TOML,
    codexIsolationPreamble(opts.headless, opts.capabilityPolicy),
    ...inheritedCodexTrustToml(opts.trustDir),
    ...gatewayConfig.tables,
    ...CODEX_TUI_TOML,
    '# Per-session codex role MCP config (managed by bootstrap-role / writeRoleCodexHome).',
    '[mcp_servers.papercusp]',
    `url = "${tomlEscape(opts.mcpUrl)}"`,
    // tools:invoke allows 1080s and the MCP host adds a 5s buffer; keep
    // Codex's per-server timeout 5s above that 1085s wrapper deadline.
    'tool_timeout_sec = 1090',
    // Coordination is part of the managed runtime. An optional MCP server
    // lets Codex submit its first model step before its catalog is available.
    'required = true',
    ...CODEX_MANAGED_DISPATCHER_APPROVAL_TOML,
    '',
  ].join('\n');
  publishCodexConfig(configPath, toml);

  // P-030: a role codex session edits files too — install the same SU-locks
  // hooks so its edits are coordinated (the role home previously had none,
  // a silent gap). Launcher must pass --dangerously-bypass-hook-trust. A role
  // session is a WORKER, so it also reports to the activity bridge (under its
  // session identity); no coordSid → the merged hook's coord fold stays OFF
  // (PAPERCUSP_COORD_FOLD=0, roles don't ride the SU coord bus).
  const hooksInstalled = writeCodexLockHooks(codexHome, {
    lockSid: opts.sid,
    advSessionId: opts.sessionKey,
    activitySid: opts.sid,
    objectiveSid: opts.sid,
    injectSid: opts.sid,
    agentSession: true,
    headless: opts.headless,
    mcpUrl: opts.mcpUrl,
  });
  const lockRuntime = readCodexLockRuntimeVerdict({
    ownerId: opts.sid ?? `role-${opts.sessionKey}`,
    hooksConfigured: hooksInstalled,
  });
  const agentsText = codexAgentsPrompt(opts.promptText, lockRuntime);
  const instructionLint = lintInstructionText(agentsText);
  writeFileSync(agentsPath, agentsText, { mode: 0o600 });
  writeCodexHomeDiagnostics(codexHome, {
    hooksInstalled,
    inheritedPromptsCopied,
    lockOwnerSid: opts.sid,
    lockRuntime,
    modelCatalog,
  });

  return { codexHome, sqliteHome, agentsPath, configPath, instructionLint };
}

/** The production request paths use the bounded worker queue so Codex-home
 *  materialization never performs synchronous filesystem writes on the host
 *  event loop. The synchronous form remains for isolated scripts and tests. */
export async function writeRoleCodexHomeAsync(
  opts: WriteRoleCodexHomeOptions,
): Promise<RoleCodexHome> {
  const codexHome = codexHomeForSessionKey(opts.sessionKey);
  return withCodexHomeAsyncWriteLock(codexHome, () =>
    runCodexHomeMaterializerJob<RoleCodexHome>({ operation: 'role-write', options: opts, homeDir: homedir() }),
  );
}

export interface SuCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** Fast, session-keyed directory configured as Codex's `sqlite_home`. */
  sqliteHome: string;
  /** The AGENTS.md (engineer playbook) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (superuser MCP) path — diagnostics. */
  configPath: string;
  /** Lint of the exact AGENTS.md written after runtime lock-mode resolution. */
  instructionLint: InstructionLintReport;
}

// Keep the public read API available for existing launch/config callers while
// allowing dossier consumers to import the reader without loading this writer.
export { readCodexHomeDiagnostics } from './codex-home-diagnostics';
export type { CodexHomeDiagnostics, CodexPapercuspDiagnostics } from './codex-home-diagnostics';

/**
 * Materialize a per-session CODEX_HOME for an interactive SUPERUSER (`su`)
 * codex session (psu su --agent=codex). The codex counterpart of the
 * claude/omp raw-CLI su launch — codex has no --mcp-config/-prompt flags,
 * so the engineer playbook is AGENTS.md and the superuser MCP is declared
 * in config.toml. Per-session port of install-standalone-mcp.sh §4f
 * (the static `codex-su` home), with two differences:
 *   - the `&client=<sid>` is baked per session (codex does NOT env-expand
 *     config.toml; the static wrapper overrode it via `-c` at launch).
 *   - the SU-locks hooks are written here (writeCodexLockHooks), so the
 *     home is self-contained.
 *
 * D-006 — the superuser bearer is baked into config.toml as
 * `http_headers = { Authorization = "Bearer <tok>" }`, NOT via
 * `bearer_token_env_var`. Verified on codex 0.135: the env-var form
 * connects but does NOT deliver a valid bearer for a streamable_http
 * server (→ `isSuperuser:false`), while the baked header works
 * (→ `isSuperuser:true`, the 217-tool superuser surface). The static
 * `codex-su` wrapper uses the env-var form and shares this latent bug.
 * Baking the token is acceptable: the home is mode-0600 + ephemeral
 * (rebuilt each launch), exactly like claude's `~/.claude.json` header.
 * Launcher execs codex with `--dangerously-bypass-hook-trust`.
 */
/** Inputs the su `config.toml` is rendered from — the subset of
 *  `writeSuCodexHome`'s options that end up IN the file. */
export interface SuCodexConfigInput {
  /** Server-issued possession token for this exact runtime; private config only. */
  nativeRuntimeBearer?: string | null;
  capabilityPolicy?: NonNullable<Parameters<typeof codexManagedFeaturesToml>[0]>['capabilityPolicy'];
  /** Host confinement policy: only the declared native role and assignment
   * may populate this home's readable context and connectors. */
  denyAmbientContext?: true;
  mcpUrl: string;
  sid: string;
  /** Absolute per-session directory Codex uses for its plaintext TUI log. */
  logDir?: string | null;
  /** Launch model. Omit/null resolves the managed Sol xhigh default, which keeps
   *  repair and model-less resume paths aligned with a fresh launch. */
  model?: string | null;
  /** Per-session soft compaction ceiling recovered from the recorded psu argv. */
  compactionLimit?: number | null;
  /** Minimum native auto-compaction threshold needed to load the measured startup prompt. */
  startupFloorTokens?: number | null;
  /** Direct per-session CODEX_HOME whose model registry should seed context roots. */
  codexHome?: string | null;
  /** Fast session companion for Codex's high-write SQLite state. */
  sqliteHome?: string | null;
  token?: string | null;
  codexGatewayAccountId?: string | null;
  codexGatewayAuto?: boolean;
  codexGatewayPriority?: string | null;
  /** Suppress optional interactive plugin authentication in an unattended TUI. */
  headless?: boolean;
  trustDir?: string | null;
  /** Launch cwd for project-scoped external HTTP MCP servers. */
  projectDir?: string | null;
}

function startupFloorForCodexPrompt(model: string | null | undefined, codexHome: string, promptText: string | null | undefined): number | null {
  const prompt = String(promptText ?? '').trim();
  if (!prompt) return null;
  const budget = buildContextBudget({
    agent: 'codex',
    model,
    codexHome,
    contextSize: 'full',
    promptText: prompt,
  });
  return budget.baselineTokens + budget.reserveTokens;
}

function resolveStartupFloorTokens(
  model: string | null | undefined,
  codexHome: string,
  promptText: string | null | undefined,
  requestedFloor: number | null | undefined,
): number | null {
  if (typeof requestedFloor === 'number' && Number.isFinite(requestedFloor) && requestedFloor > 0) {
    return Math.floor(requestedFloor);
  }
  return startupFloorForCodexPrompt(model, codexHome, promptText);
}

/** Claude stores project MCP choices in its user config. Carry HTTP entries
 * into the isolated Codex home so changing clients does not hide a connector.
 * The platform server remains session-scoped and always wins name collisions. */
function projectHttpMcpToml(projectDir: string | null | undefined): string[] {
  const lines = ['# BEGIN inherited project HTTP MCP', '# END inherited project HTTP MCP'];
  if (!projectDir) return lines;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const servers = config.projects?.[resolve(projectDir)]?.mcpServers ?? {};
    const entries: string[] = [];
    for (const [name, raw] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      if (name === 'papercusp' || name === 'papercusp-su' || !raw || typeof raw !== 'object') continue;
      const server = raw as { type?: unknown; url?: unknown; headers?: unknown };
      if (server.type !== 'http' || typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)) continue;
      entries.push(`[mcp_servers."${tomlEscape(name)}"]`, `url = "${tomlEscape(server.url)}"`);
      if (server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)) {
        const headers = Object.entries(server.headers)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, value]) => `"${tomlEscape(key)}" = "${tomlEscape(value)}"`);
        if (headers.length) entries.push(`http_headers = { ${headers.join(', ')} }`);
      }
    }
    return [lines[0], ...entries, lines[1]];
  } catch {
    return lines;
  }
}

/** Append the per-session MCP client exactly once without reserializing signed
 * role URLs (query order/encoding are part of their signature). */
function mcpUrlWithClient(mcpUrl: string, sid: string): string {
  if (/[?&]client=/.test(mcpUrl)) return mcpUrl;
  const sep = mcpUrl.includes('?') ? '&' : '?';
  return `${mcpUrl}${sep}client=${encodeURIComponent(sid)}`;
}

/**
 * The su `config.toml` body. ONE renderer, two callers: `writeSuCodexHome`
 * (fresh home) and `ensureSuCodexHomeConfig` (repair an existing home). Kept
 * as a shared function rather than copied into the repair path because a second
 * renderer that drifted would make a repaired home quietly differ from a freshly
 * launched one — the exact drift class the codex-gateway-config extraction was
 * done to end (WI-3645).
 *
 * The per-session client identity is baked into the url because codex cannot
 * env-expand config.toml, and the superuser bearer rides as an http_headers
 * Authorization (D-006 — the env-var form doesn't deliver on codex 0.135).
 * `env_http_headers` supplies a legacy process-environment native-session claim.
 * The MCP host prefers Codex's per-call _meta.threadId, since the process can
 * inherit a parent's CODEX_SESSION_ID while shell tools receive the current id.
 * Both carriers are checked against the owner's registered native incarnation.
 */
export function suCodexConfigToml(opts: SuCodexConfigInput): string {
  if (opts.nativeRuntimeBearer && (!/^[A-Za-z0-9_-]{43}$/.test(opts.nativeRuntimeBearer)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(opts.mcpUrl).hostname))) {
    throw new Error('native_runtime_delivery_denied');
  }
  const url = mcpUrlWithClient(opts.mcpUrl, opts.sid);
  const gatewayConfig = codexGatewayConfigToml(opts.codexGatewayAccountId, {
    nativeRuntimeBearer: opts.nativeRuntimeBearer,
    gatewayOn: opts.codexGatewayAuto,
    ownerId: opts.sid,
    priority: opts.codexGatewayPriority,
  });
  // Keep the effective model in the per-session root config so a resume that
  // has no CLI `-m` flag cannot fall through to CODEX_HOME/models_cache.json.
  const resolvedModel = resolveCodexModel(opts.model);
  const modelConfig = codexModelConfigToml(resolvedModel);
  const contextConfig = codexContextConfigToml(resolvedModel, {
    codexHome: opts.codexHome ?? undefined,
    compactionLimit: opts.compactionLimit,
    startupFloorTokens: opts.startupFloorTokens,
  }).trimEnd();
  // D-005 route 2: a non-gateway home points at its stripped catalog. The
  // writers (writeSuCodexHome / ensureSuCodexHomeConfig) materialize the file
  // at this deterministic path before publishing the config.
  const modelCatalogLine = gatewayConfig.root.length === 0 && opts.codexHome
    ? codexModelCatalogToml(join(opts.codexHome, CODEX_MANAGED_MODEL_CATALOG_FILE))
    : [];
  return [
    ...(contextConfig ? contextConfig.split('\n') : []),
    ...modelConfig,
    ...modelCatalogLine,
    ...(opts.sqliteHome ? [`sqlite_home = "${tomlEscape(opts.sqliteHome)}"`] : []),
    ...(opts.logDir ? [`log_dir = "${tomlEscape(opts.logDir)}"`] : []),
    ...gatewayConfig.root,
    ...CODEX_DANGER_TOML,
    codexIsolationPreamble(opts.headless, opts.capabilityPolicy),
    ...inheritedCodexTrustToml(opts.trustDir, opts.denyAmbientContext !== true),
    ...gatewayConfig.tables,
    ...CODEX_TUI_TOML,
    '# Per-session codex SU home config (managed by bootstrap-su / writeSuCodexHome).',
    '[mcp_servers.papercusp-su]',
    `url = "${tomlEscape(url)}"`,
    // Papercusp tools can declare a 600s deadline plus a 5s MCP buffer.
    // Keep Codex's per-server client timeout just above that contract.
    'tool_timeout_sec = 610',
    // Managed turns require Papercusp tools from their first model step.
    'required = true',
    ...CODEX_MANAGED_DISPATCHER_APPROVAL_TOML,
    ...(opts.token || opts.nativeRuntimeBearer ? [`http_headers = { ${[
      ...(opts.token ? [`Authorization = "Bearer ${tomlEscape(opts.token)}"`] : []),
      ...(opts.nativeRuntimeBearer ? [`"x-papercusp-native-runtime" = "${opts.nativeRuntimeBearer}"`] : []),
    ].join(', ')} }`] : []),
    'env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }',
    ...projectHttpMcpToml(opts.denyAmbientContext ? null : opts.projectDir ?? opts.trustDir),
    '',
  ].join('\n');
}

/**
 * REPAIR an existing CODEX_HOME's `config.toml` in place — the resume-leg
 * counterpart to `writeSuCodexHome`, and deliberately NOT that function.
 *
 * `writeSuCodexHome` rebuilds generated launch files while retaining native
 * transcripts. A resume must also retain its prompt, auth and SQLite state;
 * it must not run the fresh-launch reset. This repairs
 * only managed launch files in place: config.toml plus identity-bearing hooks /
 * diagnostics when their owner has drifted. Rollouts, prompts and auth survive.
 *
 * WI-38706: the archiver had been unlinking these configs (it took the home's
 * shared state under one thread's session id), leaving codex to re-create an
 * 87-byte trust-only stub on the next launch — no MCP server, no approvals
 * bypass, no gateway provider — so the resume either died on the missing provider
 * or came up silently uncoordinated. `existsSync(home)` is required, not created:
 * a home that is not there has no rollouts to resume and must not be conjured.
 *
 * Idempotent: a home already carrying `[mcp_servers.papercusp-su]` AND the
 * context roots required by its recorded launch model is left byte-identical
 * and reported `repaired: false`. Older managed homes that predate the roots
 * (or carry superseded values) are rewritten from this canonical renderer so a
 * model-less resume cannot silently fall back to Codex's smaller native window.
 */
function ensureSuCodexHomeConfigImpl(opts: SuCodexConfigInput & {
  sessionKey: string | number;
  /** SQLite binding from this exact session's persisted launch receipt. */
  recordedSqliteHome?: string | null;
  /** Canonical, current SU render; supplied by the operator repair route. */
  promptText?: string;
  /** A carry starts a fresh thread, so a GC-removed home can be recreated safely. */
  recoverMissingHome?: boolean;
}, ownerSidIo?: CodexHomeOwnerSidIo): {
  codexHome: string;
  sqliteHome: string;
  configPath: string;
  repaired: boolean;
  /** The native runtime owns config.toml; an exact receipt allowed a safe no-op. */
  configUnreadable?: boolean;
  identityRepaired: boolean;
  promptRepaired: boolean;
  reason?: 'no-home';
} {
  const codexHome = codexHomeForSessionKey(opts.sessionKey);
  const configPath = join(codexHome, 'config.toml');
  let configUnreadable = false;
  if (existsSync(configPath)) {
    try { readFileSync(configPath, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (opts.recordedSqliteHome && (code === 'EACCES' || code === 'EPERM')) configUnreadable = true;
      else throw error;
    }
  }
  const sqliteHome = preservedCodexSqliteHome(codexHome, opts.sessionKey, opts.recordedSqliteHome, configUnreadable, false, opts.sid);
  if (!existsSync(codexHome)) {
    if (!opts.recoverMissingHome || !opts.promptText?.trim()) {
      return { codexHome, sqliteHome, configPath, repaired: false, identityRepaired: false, promptRepaired: false, reason: 'no-home' };
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    if (!opts.denyAmbientContext) inheritUserCodexHome(codexHome);
    ensureCodexSkillWatchRoots({ codexHome });
  }
  // The file is already being replaced by the native runtime. The exact
  // session receipt proves which SQLite companion belongs to this launch, but
  // the host must not race the runtime by rewriting its private config.
  if (configUnreadable) {
    return { codexHome, sqliteHome, configPath, repaired: false, identityRepaired: false, promptRepaired: false, configUnreadable: true };
  }
  // The recorded home can be repaired without the original launch options.
  // Reuse its existing diagnostics rather than granting ambient inheritance.
  const diagnosticsPath = join(codexHome, 'papercusp-diagnostics.json');
  let diagnostics: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) diagnostics = parsed;
    if (diagnostics.denyAmbientContext === true) {
      opts = { ...opts, denyAmbientContext: true };
    }
  } catch { /* Legacy/unconfined homes have no saved context policy. */ }
  const contextPolicyRepaired = opts.denyAmbientContext === true && diagnostics.denyAmbientContext !== true;
  if (contextPolicyRepaired) {
    writeFileSync(diagnosticsPath, `${JSON.stringify({ ...diagnostics, denyAmbientContext: true }, null, 2)}\n`, { mode: 0o600 });
  }
  mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  const logDir = join(codexHome, 'log');
  mkdirSync(logDir, { recursive: true });
  const resolvedModel = resolveCodexModel(opts.model);
  let startupPromptText = opts.promptText;
  if (!startupPromptText) {
    try { startupPromptText = readFileSync(join(codexHome, 'AGENTS.md'), 'utf8'); }
    catch { startupPromptText = ''; }
  }
  const startupFloorTokens = resolveStartupFloorTokens(
    resolvedModel,
    codexHome,
    startupPromptText,
    opts.startupFloorTokens,
  );
  const expectedModelConfig = codexModelConfigToml(resolvedModel).join('\n');
  const expectedContextConfig = codexContextConfigToml(resolvedModel, {
    codexHome,
    compactionLimit: opts.compactionLimit,
    startupFloorTokens,
  });
  const expectedLogDir = `log_dir = "${tomlEscape(logDir)}"`;
  const expectedSqliteHome = `sqlite_home = "${tomlEscape(sqliteHome)}"`;
  const expectedClient = `client=${encodeURIComponent(opts.sid)}`;
  const expectedNativeSessionHeader = 'env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }';
  const expectedSuMcpRoute =
    '[mcp_servers.papercusp-su]\nurl = "' +
    tomlEscape(mcpUrlWithClient(opts.mcpUrl, opts.sid)) +
    '"\ntool_timeout_sec = 610\nrequired = true';
  const expectedGateway = codexGatewayConfigToml(opts.codexGatewayAccountId, {
    nativeRuntimeBearer: opts.nativeRuntimeBearer,
    gatewayOn: opts.codexGatewayAuto,
    ownerId: opts.sid,
    priority: opts.codexGatewayPriority,
  });
  const expectedProjectMcp = projectHttpMcpToml(opts.denyAmbientContext ? null : opts.projectDir ?? opts.trustDir).join('\n');
  // D-005: a resumed non-gateway home re-strips the freshest catalog on every
  // repair (a home written before this change has none); a gateway home has none.
  const modelCatalog = materializeHomeModelCatalog(codexHome, expectedGateway.root.length > 0);
  const expectedCatalogLine = codexModelCatalogToml(join(codexHome, CODEX_MANAGED_MODEL_CATALOG_FILE)).join('\n');
  let configReady = false;
  try {
    const current = readFileSync(configPath, 'utf8');
    const parsedCurrent = parseToml(current) as { features?: Record<string, unknown>;
      mcp_servers?: Record<string, { http_headers?: Record<string, unknown> }> };
    // Repair never adopts a stored possession token as launch authority. A
    // caller must supply a freshly verified/reissued credential explicitly;
    // otherwise remove even a direct-route home's stale header.
    const nativeRuntimeReady = parsedCurrent.mcp_servers?.['papercusp-su']?.http_headers?.['x-papercusp-native-runtime']
      === (opts.nativeRuntimeBearer || undefined);
    const expectedFeatures = (parseToml(codexIsolationPreamble(opts.headless, opts.capabilityPolicy)) as {
      features?: Record<string, unknown>;
    }).features;
    // Resume repair must both restore an admitted control and remove stale
    // controls after rollback or version drift. Checking only present expected
    // keys would leave yesterday's shell_tool=false silently active.
    const capabilityPolicyReady = Object.values(CODEX_CAPABILITY_CONTROLS).every(control =>
      Object.keys(control.features).every(key => parsedCurrent.features?.[key] === expectedFeatures?.[key]));
    const subagentPolicyReady =
      parsedCurrent.features?.multi_agent === false &&
      parsedCurrent.features?.goals === false &&
      (modelCatalog ? current.includes(expectedCatalogLine) : !/^model_catalog_json\s*=/m.test(current));
    const modelMatches = current.includes(expectedModelConfig);
    const contextMatches = modelMatches && (expectedContextConfig
      ? current.includes(expectedContextConfig.trimEnd())
      : !/^model_(?:context_window|auto_compact_token_limit)\s*=/m.test(current));
    const gatewayReady = expectedGateway.root.length
      ? current.includes(expectedGateway.root.join('\n')) && current.includes(expectedGateway.tables.join('\n'))
      : !current.includes('PAPERCUSP_CODEX_GATEWAY_ROOT') && !current.includes('PAPERCUSP_CODEX_GATEWAY_PROVIDER');
    const hasHeadlessPluginsPolicy = current.includes('plugins = false');
    const hasHeadlessAuthPolicy = current.includes('auth_elicitation = false');
    const headlessPolicyReady = opts.headless === true
      ? hasHeadlessPluginsPolicy && hasHeadlessAuthPolicy
      : !hasHeadlessPluginsPolicy && !hasHeadlessAuthPolicy;
    configReady =
      current.includes(expectedSuMcpRoute) &&
      current.includes(expectedProjectMcp) &&
      current.includes(expectedClient) &&
      current.includes(expectedNativeSessionHeader) &&
      parseToml(current).check_for_update_on_startup === false &&
      contextMatches &&
      current.includes(expectedSqliteHome) &&
      current.includes(expectedLogDir) &&
      current.includes('[tui]\nterminal_title = []\nalternate_screen = "never"\n') &&
      gatewayReady &&
      nativeRuntimeReady &&
      headlessPolicyReady &&
      capabilityPolicyReady &&
      subagentPolicyReady &&
      (!opts.denyAmbientContext || current === suCodexConfigToml({
        ...opts, logDir, codexHome, sqliteHome, startupFloorTokens,
      }));
  } catch {
    /* absent or unreadable — that is precisely the repair case */
  }
  if (!configReady) {
    publishCodexConfig(configPath, suCodexConfigToml({
      ...opts, logDir, codexHome, sqliteHome, startupFloorTokens,
    }));
  }
  const identity = repairSuCodexHomeIdentityImpl(
    codexHome,
    opts.sid,
    opts.sessionKey,
    mcpUrlWithClient(opts.mcpUrl, opts.sid),
    ownerSidIo,
    opts.headless,
  );
  const agentsPath = join(codexHome, 'AGENTS.md');
  const carryBasePath = join(codexHome, '.papercusp-carry-base-AGENTS.md');
  const readBase = (path: string): string => {
    try {
      return readFileSync(path, 'utf8').split(/\n---\n## Managed carry checkpoint\b/)[0].trim();
    } catch {
      return '';
    }
  };
  // The carry minter prefers its base snapshot over AGENTS.md. Repair BOTH
  // whenever either is empty, otherwise a prior empty snapshot wins again.
  const agentsBase = readBase(agentsPath);
  const snapshotExists = existsSync(carryBasePath);
  const snapshotBase = snapshotExists ? readBase(carryBasePath) : agentsBase;
  const promptRepaired = !!opts.promptText?.trim() && (!agentsBase || !snapshotBase);
  if (promptRepaired) {
    const lockRuntime = readCodexLockRuntimeVerdict({
      ownerId: opts.sid,
      hooksConfigured: identity.hooksInstalled,
    });
    const canonicalPrompt = codexAgentsPrompt(opts.promptText!, lockRuntime);
    writeFileSync(agentsPath, canonicalPrompt, { mode: 0o600 });
    writeFileSync(carryBasePath, canonicalPrompt, { mode: 0o600 });
  }
  return {
    codexHome,
    sqliteHome,
    configPath,
    repaired: !configReady || identity.repaired || promptRepaired || contextPolicyRepaired,
    identityRepaired: identity.repaired,
    promptRepaired,
  };
}

type EnsureSuCodexHomeConfigOptions = SuCodexConfigInput & {
  sessionKey: string | number;
  /** SQLite binding from this exact session's persisted launch receipt. */
  recordedSqliteHome?: string | null;
  /** Canonical, current SU render; supplied by the operator repair route. */
  promptText?: string;
  /** A carry starts a fresh thread, so a GC-removed home can be recreated safely. */
  recoverMissingHome?: boolean;
};

export function ensureSuCodexHomeConfig(opts: EnsureSuCodexHomeConfigOptions) {
  return ensureSuCodexHomeConfigImpl(opts);
}

export async function ensureSuCodexHomeConfigAsync(
  opts: EnsureSuCodexHomeConfigOptions,
): Promise<ReturnType<typeof ensureSuCodexHomeConfigImpl>> {
  const codexHome = codexHomeForSessionKey(opts.sessionKey);
  return withCodexHomeAsyncWriteLock(codexHome, async () => {
    const priorSid = await existingCodexHomeOwnerSidAsync(codexHome);
    const result = await runCodexHomeMaterializerJob<ReturnType<typeof ensureSuCodexHomeConfigImpl>>({
      operation: 'su-ensure-config', options: opts, priorSid, homeDir: homedir(),
    });
    if (result.identityRepaired) await stampCodexHomeOwnerSidAsync(codexHome, opts.sid);
    return result;
  });
}

type WriteSuCodexHomeOptions = {
  nativeRuntimeBearer?: SuCodexConfigInput['nativeRuntimeBearer'];
  /** Task-ledger id of the launching agent task, stamped into the session's activity identity. */
  agentTaskId?: string;
  capabilityPolicy?: SuCodexConfigInput['capabilityPolicy'];
  /** Same host-owned context ceiling consulted by bootstrap and MCP. */
  denyAmbientContext?: true;
  sessionKey: string | number;
  /** Superuser MCP url (?superuser=1&workspace=…) from buildLaunchSpec(su). */
  mcpUrl: string;
  /** The engineer playbook — becomes AGENTS.md. */
  promptText: string;
  /** Per-session coordination identity, baked into the url's &client=. */
  sid: string;
  /** Launch model. Extended-window models bake their canonical root keys into
   *  config.toml so model-less resumes retain the launch window. */
  model?: string | null;
  /** Per-session soft compaction ceiling recovered from the recorded psu argv. */
  compactionLimit?: number | null;
  /** Minimum native auto-compaction threshold needed to load the measured startup prompt. */
  startupFloorTokens?: number | null;
  /** Superuser bearer token, baked as an http_headers Authorization (D-006).
   *  Omit only when no token is installed → a degraded non-superuser home. */
  token?: string | null;
  /** Optional Codex account pin; writes a custom model provider that points Codex at the inference gateway. */
  codexGatewayAccountId?: string | null;
  /** Route through the gateway with NO pin (explicit-auto, WI-3645): writes the SAME provider
   *  block with the x-papercusp-account header omitted — the gateway auto-selects. Ignored
   *  when codexGatewayAccountId is set. */
  codexGatewayAuto?: boolean;
  /** Gateway admission label; `su` for interactive SU homes. */
  codexGatewayPriority?: string | null;
  /** Suppress optional interactive plugin authentication in an unattended TUI. */
  headless?: boolean;
  /** The directory the operator is launching this SU session into (resolveSuLaunchCwd).
   *  Seeded as `[projects."<dir>"] trust_level = "trusted"` so a fresh CODEX_HOME
   *  does not block at codex's "Do you trust this directory?" boot prompt. */
  trustDir?: string | null;
  /** Canonical launch-time mode/route/scope state for the machine-readable
   * instruction precedence trace carried by the exact AGENTS.md lint. */
  instructionRuntime?: InstructionRuntimeContext;
  /** EI-11366 identity-split guard: liveness check for a PRIOR occupant of this
   *  sessionKey's home directory. Injected (not statically imported) so this
   *  module stays dependency-free/pure for its unit tests — the real production
   *  check is `findLiveHost` (psu-pty-discovery), wired by bootstrap-su.ts.
   *  Omitted ⇒ the collision check is skipped entirely (byte-identical to the
   *  pre-guard behavior — safe default for every existing caller/test). */
  isOwnerLive?: (sid: string) => boolean;
};

function writeSuCodexHomeImpl(opts: WriteSuCodexHomeOptions, ownerSidIo?: CodexHomeOwnerSidIo): SuCodexHome {
  const targetHome = codexHomeForSessionKey(opts.sessionKey);
  // EI-11366: a live Codex psu host was once found split across two identities
  // — the physical host process/PAPERCUSP_SID/socket stayed with its ORIGINAL
  // sid while CODEX_HOME/hooks.json on disk had been silently regenerated for a
  // DIFFERENT sid. `freshCodexHome` below rebuilds generated launch files but
  // retains native transcripts, including on re-preparing the SAME logical
  // session. The identity guard still checks whether the home being rebuilt is
  // still the ACTIVE home of a DIFFERENT, currently-live session. If a future
  // caller (a retry path, a sessionKey computed by different code, an operator
  // debug script) ever passes a sessionKey that collides with a still-live
  // OTHER sid's home, this converts a silent identity-split into a loud,
  // diagnosable refusal instead. Fails OPEN (proceeds, current behavior) unless
  // BOTH a differing prior owner AND a caller-supplied liveness check confirm
  // it is still live — never blocks a normal fresh/re-prepare launch.
  const priorSid = ownerSidIo ? ownerSidIo.priorSid : existingCodexHomeOwnerSid(targetHome);
  if (priorSid && priorSid !== opts.sid && opts.isOwnerLive?.(priorSid)) {
    throw new Error(
      `writeSuCodexHome: refusing to rebuild ${targetHome} — it is the LIVE Codex home of a ` +
        `different session (owner ${priorSid}); overwriting it would silently split that ` +
        `session's identity between its still-running process and a rewritten CODEX_HOME ` +
        `(EI-11366). Pass the SAME sid to re-prepare that session, or a sessionKey that does ` +
        `not collide with a live session's home.`,
    );
  }
  // Resolve the verified same-owner binding BEFORE freshCodexHome removes the
  // generated config. Re-preparation retains native transcripts, so it must
  // retain their SQLite database and WAL too, even if the serving root changed.
  // A missing/invalid binding refuses before either home is mutated.
  const retainedSqliteHome = priorSid === opts.sid
    ? preservedCodexSqliteHome(targetHome, opts.sessionKey, undefined, false, true)
    : null;
  const codexHome = freshCodexHome(targetHome, opts.denyAmbientContext !== true);
  const sqliteHome = retainedSqliteHome ?? freshCodexSqliteHome(opts.sessionKey);
  if (retainedSqliteHome) mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  const inheritedPromptsCopied = !opts.denyAmbientContext && copyInheritedCodexPrompts(codexHome);

  const agentsPath = join(codexHome, 'AGENTS.md');

  // Bake the per-session client identity into the url (codex can't env-expand
  // config.toml) + the superuser bearer as an http_headers Authorization
  // (D-006 — the env-var form doesn't deliver on codex 0.135).
  const configPath = join(codexHome, 'config.toml');
  const logDir = join(codexHome, 'log');
  mkdirSync(logDir, { recursive: true });
  const modelCatalog = materializeHomeModelCatalog(
    codexHome,
    codexGatewayConfigToml(opts.codexGatewayAccountId, { gatewayOn: opts.codexGatewayAuto }).root.length > 0,
  );
  const startupFloorTokens = resolveStartupFloorTokens(
    opts.model,
    targetHome,
    opts.promptText,
    opts.startupFloorTokens,
  );
  publishCodexConfig(configPath, suCodexConfigToml({
    ...opts, logDir, codexHome: targetHome, sqliteHome, startupFloorTokens,
  }));

  // SU sessions pass coordSid so the merged activity hook's coord fold stays
  // ON (new coord:inbox messages folded into the SAME activity:report round
  // trip, parity with the Claude global-settings coord entry, EI-11405) — an
  // SU/engineer session is a worker too, so it gets the activity bridge either
  // way; both keyed to the session id.
  const hooksInstalled = writeCodexLockHooks(codexHome, {
    lockSid: opts.sid,
    coordSid: opts.sid,
    activitySid: opts.sid,
    advSessionId: opts.sessionKey,
    agentTaskId: opts.agentTaskId,
    objectiveSid: opts.sid,
    injectSid: opts.sid,
    mcpUrl: mcpUrlWithClient(opts.mcpUrl, opts.sid),
    headless: opts.headless,
    mcpUsesSuperuserToken: true,
  });
  const lockRuntime = readCodexLockRuntimeVerdict({ ownerId: opts.sid, hooksConfigured: hooksInstalled });
  const agentsText = codexAgentsPrompt(opts.promptText, lockRuntime);
  const instructionLint = lintInstructionText(agentsText, 20, opts.instructionRuntime);
  writeFileSync(agentsPath, agentsText, { mode: 0o600 });
  writeCodexHomeDiagnostics(codexHome, {
    hooksInstalled,
    inheritedPromptsCopied,
    denyAmbientContext: opts.denyAmbientContext === true,
    lockOwnerSid: opts.sid,
    lockRuntime,
    modelCatalog,
  });
  // EI-11366: stamp the sentinel the collision guard above reads on the NEXT
  // write to this sessionKey's home. Best-effort — a write failure here must
  // never fail the launch (mirrors every other diagnostics write in this fn).
  if (!ownerSidIo?.skipStamp) {
    try {
      writeFileSync(join(codexHome, '.owner-sid'), opts.sid, { mode: 0o600 });
    } catch {
      /* non-fatal: the collision guard simply skips on the next write */
    }
  }

  return { codexHome, sqliteHome, agentsPath, configPath, instructionLint };
}

export function writeSuCodexHome(opts: WriteSuCodexHomeOptions): SuCodexHome {
  return writeSuCodexHomeImpl(opts);
}

export async function writeSuCodexHomeAsync(
  opts: Omit<WriteSuCodexHomeOptions, 'isOwnerLive'> & {
    isOwnerLive?: (sid: string) => boolean | Promise<boolean>;
  },
): Promise<SuCodexHome> {
  const targetHome = codexHomeForSessionKey(opts.sessionKey);
  return withCodexHomeAsyncWriteLock(targetHome, async () => {
    const priorSid = await existingCodexHomeOwnerSidAsync(targetHome);
    if (priorSid && priorSid !== opts.sid && opts.isOwnerLive && await opts.isOwnerLive(priorSid)) {
      throw new Error(
        `writeSuCodexHome: refusing to rebuild ${targetHome} — it is the LIVE Codex home of a ` +
          `different session (owner ${priorSid}); overwriting it would silently split that ` +
          `session's identity between its still-running process and a rewritten CODEX_HOME ` +
          `(EI-11366). Pass the SAME sid to re-prepare that session, or a sessionKey that does ` +
          `not collide with a live session's home.`,
      );
    }
    const { isOwnerLive: _isOwnerLive, ...writeOpts } = opts;
    const result = await runCodexHomeMaterializerJob<SuCodexHome>({
      operation: 'su-write', options: writeOpts, priorSid, homeDir: homedir(),
    });
    await stampCodexHomeOwnerSidAsync(result.codexHome, opts.sid);
    return result;
  });
}

/** Worker entry dispatch. Keep the synchronous implementations here so their
 *  existing filesystem and identity semantics remain the single source of truth. */
export function executeCodexHomeMaterializerJob(job: CodexHomeMaterializerJob): unknown {
  const previousHome = materializerHomeOverride;
  materializerHomeOverride = job.homeDir ?? previousHome;
  try {
    switch (job.operation) {
      case 'role-write':
        return writeRoleCodexHome(job.options as WriteRoleCodexHomeOptions);
      case 'su-write':
        return writeSuCodexHomeImpl(job.options as WriteSuCodexHomeOptions, {
          priorSid: job.priorSid ?? null,
          skipStamp: true,
        });
      case 'su-ensure-config':
        return ensureSuCodexHomeConfigImpl(job.options as EnsureSuCodexHomeConfigOptions, {
          priorSid: job.priorSid ?? null,
          skipStamp: true,
        });
    }
  } finally {
    materializerHomeOverride = previousHome;
  }
}

const PAPERCUSP_SU_TABLE_RE = /^mcp_servers\.(?:papercusp-su|"papercusp-su")(?:\.|$)/;

/**
 * The SU `config.toml` minus what makes it an SU session: the papercusp-su MCP
 * table (and any of its sub-tables) and the psu cap on the project's AGENTS.md.
 * Every other key and table, the project's own MCP servers included, is kept.
 */
export function codingAssistantCodexConfigToml(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) skipping = PAPERCUSP_SU_TABLE_RE.test(header[1].replace(/\s+/g, ''));
    if (skipping) continue;
    if (/^\s*project_doc_max_bytes\s*=\s*0\s*(?:#.*)?$/.test(line)) continue;
    if (line.startsWith('# psu prompt isolation')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * pui-chat-first-ux-2026-09-28 P-016 (D-004/D-005 for Codex): a PUI chat opened
 * outside every registered checkout runs Codex's own identity. This strips the
 * SU pieces from its already-written per-session home IN PLACE, so rollouts,
 * auth and the project's own MCP servers survive: the papercusp-su MCP server,
 * the cap that stops Codex reading the project's AGENTS.md, the SU playbook
 * (replaced by a COPY of the user's own `~/.codex/AGENTS.md`, never a symlink,
 * because a later SU repair writes through that path), and the managed
 * hooks.json. Idempotent. Run it on every engine start: an exact resume first
 * repairs the home back to its SU configuration.
 */
export function makeCodingAssistantCodexHome(codexHome: string, home: string = homedir()): void {
  const configPath = join(codexHome, 'config.toml');
  if (existsSync(configPath)) {
    const current = readFileSync(configPath, 'utf8');
    const next = codingAssistantCodexConfigToml(current);
    if (next !== current) publishCodexConfig(configPath, next);
  }
  const agentsPath = join(codexHome, 'AGENTS.md');
  rmSync(agentsPath, { force: true });
  const userAgents = join(home, '.codex', 'AGENTS.md');
  if (existsSync(userAgents)) {
    // Older standalone installers put the SU playbook in the user's global
    // instructions. It is generated SU context, not a personal instruction:
    // copying it back would undo the identity isolation above (EI-25332697642301259).
    // Use the installer's exact paired markers; leave unmarked user rules alone.
    const personal = readFileSync(userAgents, 'utf8').replace(
      /<!-- BEGIN papercusp-su playbook \(managed by install-standalone-mcp\.sh\) -->[\s\S]*?<!-- END papercusp-su playbook -->\r?\n?/g,
      '',
    );
    if (personal.trim()) writeFileSync(agentsPath, personal, { mode: 0o600 });
  }
  rmSync(join(codexHome, 'hooks.json'), { force: true });
}
