/**
 * account-link-cli — the WORKING "link a Max account via OAuth" flow
 * (accounts-pool-tab-2026-06-15 P-002 / D-016). It drives the REAL `claude setup-token`
 * CLI in a pty, because claude.ai rejects a hand-built authorize URL clicked in a plain
 * browser — it requires claude-code's own client handshake (see insight
 * claude-oauth-authorize-url; the hand-built authorize-URL approach — formerly
 * account-link-store.ts, since removed as orphaned dead code — was the dead-end it
 * replaces). The CLI is the client; we just relay its link + feed the owner's code back.
 *
 * Flow (the button does what an agent used to do by hand):
 *   1. startCliLink → spawn `claude setup-token` in a pty (ISOLATED CLAUDE_CONFIG_DIR so it
 *      never touches this box's ~/.claude), read its output until it prints the authorize
 *      URL, KEEP the process alive keyed by an opaque linkId, return { authorizeUrl, linkId }.
 *   2. The owner opens the URL signed into the TARGET Max account, approves, pastes the
 *      `code#state` claude.ai shows.
 *   3. completeCliLink({ linkId, code }) → write the code into the SAME running CLI, read
 *      until it mints the `sk-ant-oat…` token, write it to ~/.papercusp/deploy-credentials/<id>
 *      (0600) + registerAccount, kill the CLI. The token never reaches the browser.
 *
 * The live pty handles stay in an in-memory map. The existing cluster-owner RPC
 * registry routes sibling workers' follow-up calls to that exact process; pinning
 * a Map on globalThis alone cannot share handles across reusePort workers.
 * An idle reaper + a TTL kill abandoned links.
 */
import { spawn, type IPty } from '@lydell/node-pty';
import { cp, readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { registerAccount, normalizeAccountProvider, type AccountProvider } from './account-pool';
import { updateAccountPool, accountStatus, type AccountStatusRow } from './account-pool-store';
import { papercuspPath } from '../papercusp-root';
import { activeWorkspaceId } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import { trackDetached } from '../detached-imports';
import { resolveAgentBinarySync } from '../agent-bin-detect';
import { WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN } from '@papercusp/deployment-driver';
import { bindOwnerRpcResource, locateOwnerRpcResource, callOwnerProcess, registerOwnerRpcHandler } from '../cluster-owner-rpc';
import {
  createStoredCliLink, readStoredCliLink, finishStoredCliLink, claimStoredCliLink,
  newLinkOwner, linkOwnerLiveness, LINK_RECOVERY_RETENTION_MS,
  type LinkOwner, type StoredCliLink,
} from './account-link-state';

const ID_RE = /^[A-Za-z0-9._-]+$/;
// Match the authorize URL / the minted token in the CLI's (ANSI-stripped) output.
const URL_RE = /https:\/\/\S*\/oauth\/authorize\?[^\s'"]+/;
const CODEX_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device\b/;
const CODEX_USER_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const TOKEN_RE = /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/;
// Settle the code→token step on EITHER the minted token OR a rejection line, so a
// bad/expired code fails fast with claude's own message instead of hanging out the
// full COMPLETE_TIMEOUT_MS. (Rejection shapes seen live: "OAuth error: Request failed
// with status code 400", "Authorization failed", "Invalid …".)
const OUTCOME_RE =
  /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+|OAuth error[^\n]*|Authorization failed[^\n]*|Invalid (?:request|code|authorization)[^\n]*|status code [45]\d\d/i;
const START_TIMEOUT_MS = 30_000; // the CLI to print the URL
const COMPLETE_TIMEOUT_MS = 60_000; // the CLI to mint after we feed the code
const LINK_TTL_MS = 10 * 60 * 1000; // how long a started link waits for the owner's code
const CLI_LINK_RPC_KIND = 'account-cli-link';
// Scope process handles to this installation's credential home, like the login itself.
const cliLinkScope = () => papercuspPath('deploy-credentials');
// The current `claude setup-token` is an Ink TUI: its masked code input treats a bulk
// `code\r` write as paste text and SWALLOWS the trailing CR, so the code is never
// submitted (the "Linking…" stall). The Enter must be its OWN write, sent AFTER the
// paste settles. Proven against claude CLI v2.1.181.
const SUBMIT_ENTER_DELAY_MS = 300;

/**
 * Keep a resolved CLI runnable when the operator itself was launched with a stripped PATH.
 *
 * The managed Codex/Claude shims are Node scripts with a `#!/usr/bin/env node` shebang. An
 * absolute path fixes the first lookup, but the kernel still asks `env` to resolve `node` from
 * PATH; without the running Node prefix the pty exits 127 before the CLI can print anything.
 * Put the current Node prefix first, plus the resolved CLI's directory when it is absolute, and
 * retain the service's entries after those required launch locations.
 */
function cliSpawnPath(bin: string): string {
  const inherited = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const required = [dirname(process.execPath)];
  if (isAbsolute(bin)) required.push(dirname(bin));
  return [...new Set([...required, ...inherited])].join(delimiter);
}

/**
 * Resolve the provider CLI to a runnable path. A pty spawn of a missing binary does NOT throw a
 * catchable ENOENT — the pty just exits instantly with no output, which used to surface as the
 * misleading "did not produce an authorize URL (is `claude` installed + on PATH?)" even though
 * the real fault was the OPERATOR's environment. Operator hosts routinely run with a stripped
 * PATH (a systemd unit whose env predates a daemon-reload — the 2026-07-03 staging-api incident —
 * or a bundled desktop sidecar whose PATH starts at its own bin dir), so resolve explicitly:
 * env override verbatim → each PATH entry → well-known install dirs.
 */
export function resolveCliBin(
  provider: AccountProvider,
  env: NodeJS.ProcessEnv = process.env,
  sharedResolver: (bin: string) => string | null = resolveAgentBinarySync,
): string {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const override = provider === 'codex' ? env.CODEX_BIN : env.CLAUDE_BIN;
  if (override) return override; // explicit operator override — trust it verbatim
  if (env.PAPERCUSP_DISTRIBUTION_PROFILE === 'vm-release') {
    // The release's bin/claude and bin/codex launch psu sessions; they are not
    // vendor login CLIs. Bootstrap publishes the credential-free vendor tools
    // here for the customer identity and its readiness probes (D-423).
    const vendor = `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/${name}`;
    try {
      accessSync(vendor, constants.X_OK);
      return vendor;
    } catch {
      throw new Error(`the ${providerLabel(provider)} vendor login CLI is missing from the customer agent toolchain (${vendor}) — repair or upgrade the workspace host`);
    }
  }
  const home = homedir();
  const candidates = [
    ...(env.PATH ?? '').split(':').filter(Boolean).map((d) => `${d}/${name}`),
    `${home}/.local/bin/${name}`,
    `${home}/.claude/local/${name}`,
    `${home}/.bun/bin/${name}`,
    `${home}/.npm-global/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/home/linuxbrew/.linuxbrew/bin/${name}`,
  ];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* not here — next candidate */
    }
  }
  // The shared resolver owns Papercusp's canonical agent-binary locations, including
  // ~/.papercusp/bin and the bin directory beside the Node executable running the operator.
  // Account linking used to stop before this seam and fall back to the bare name, so a
  // systemd operator with a stripped PATH could not launch a working, installed Codex CLI.
  const shared = sharedResolver(name);
  if (shared) return shared;
  return name; // nothing found — let the pty try bare PATH lookup; the no-URL error will say so
}

function stripAnsi(s: string): string {
  // CSI sequences + OSC sequences — Ink colors its output; the URL/token would otherwise
  // be interrupted mid-string by escape codes and not match.
   
  return s.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

/**
 * Read the pty's (ANSI-stripped, accumulated) output until `re` matches, then resolve with the
 * match — disposing both listeners + the timeout on settle (no leaked handles). `after` runs once
 * the listeners are registered (e.g. write the code only after we're listening for the response).
 */
function readUntil(
  pty: IPty,
  getBuf: () => string,
  appendBuf: (d: string) => void,
  re: RegExp,
  timeoutMs: number,
  after?: () => void,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      od.dispose();
      oe.dispose();
      resolve(v);
    };
    const to = setTimeout(() => finish(null), timeoutMs);
    // Never hold the process open for a watcher timeout (the auto-mint watcher waits LINK_TTL_MS).
    (to as unknown as { unref?: () => void }).unref?.();
    const existing = stripAnsi(getBuf()).match(re);
    if (existing) {
      clearTimeout(to);
      resolve(existing[0]);
      return;
    }
    const od = pty.onData((d) => {
      appendBuf(d);
      const m = stripAnsi(getBuf()).match(re);
      if (m) finish(m[0]);
    });
    const oe = pty.onExit(() => finish(stripAnsi(getBuf()).match(re)?.[0] ?? null));
    after?.();
  });
}

interface PendingCliLink {
  workspaceId: string;
  scope: string;
  /** A recovered approved Codex home has no surviving PTY. */
  pty: IPty | null;
  owner: LinkOwner;
  buf: string;
  accountId: string;
  label?: string;
  provider: AccountProvider;
  configDir: string;
  reaper: ReturnType<typeof setTimeout>;
  /** The deferred Enter-keystroke timer (cleared on cleanup so it can't fire late). */
  enterTimer?: ReturnType<typeof setTimeout>;
  /**
   * Terminal outcome once the link finalized WITHOUT (or before) a completeCliLink call.
   * claude CLI ≥2.1.200's `setup-token` runs a localhost callback listener; when the approving
   * browser is on the SAME machine as this operator, claude.com delivers the code straight to
   * the CLI ("You're all set up … close this window" — NO code is ever shown to the owner), the
   * CLI mints the token spontaneously, and the paste step never happens. The background watcher
   * harvests that mint here; completeCliLink and getCliLinkStatus report it.
   */
  done?: { ok: true; account: AccountStatusRow | null } | { ok: false; error: string };
  /** In-flight finalization (serializes the watcher vs an explicit completeCliLink race). */
  finalizing?: Promise<CompleteCliLinkResult>;
}

/** How long a FINALIZED link entry stays queryable (getCliLinkStatus / a late complete click). */
const DONE_GRACE_MS = 5 * 60 * 1000;

/**
 * Persist + register a minted claude token for a held link — the SINGLE finalization path for
 * both the pasted-code flow and the ≥2.1.200 auto-callback mint. Idempotent: concurrent callers
 * share one finalizing promise. Releases the pty + isolated config dir immediately but KEEPS the
 * map entry for DONE_GRACE_MS so the UI/agent can still read the outcome.
 */
function finalizeClaudeToken(
  linkId: string,
  l: PendingCliLink,
  token: string,
  _workspace: string | undefined,
  deps: CompleteCliLinkDeps,
): Promise<CompleteCliLinkResult> {
  if (l.done) return Promise.resolve(l.done);
  l.finalizing ??= runWithWorkspace(l.workspaceId, async () => {
    try {
      const held = await readStoredCliLink(linkId, l.scope);
      if (held?.owner.nonce !== l.owner.nonce) throw new Error('link custody changed');
      const credPath = `${l.scope}/${l.accountId}`;
      await mkdir(dirname(credPath), { recursive: true });
      await writeFile(credPath, token, { mode: 0o600 });
      await chmod(credPath, 0o600);
      const credentialRef = `token:${credPath}`;
      await updateAccountPool((p) => registerAccount(p, { id: l.accountId, credentialRef, label: l.label }, Date.now()), l.workspaceId);
      const account = (await accountStatus(l.workspaceId)).find((a) => a.id === l.accountId) ?? null;
      if (!await finishStoredCliLink(linkId, l.scope, l.owner.nonce, 'completed')) {
        throw new Error('link custody changed');
      }
      l.done = { ok: true, account };
    } catch (e) {
      l.done = { ok: false, error: `register failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
      // Retain the isolated home and original owner on an uncommitted outcome.
      return l.done;
    }
    clearTimeout(l.reaper);
    if (l.enterTimer) clearTimeout(l.enterTimer);
    try {
      l.pty?.kill();
    } catch {
      /* already exited */
    }
    void rm(l.configDir, { recursive: true, force: true }).catch(() => {});
    l.reaper = setTimeout(() => links.delete(linkId), DONE_GRACE_MS);
    (deps.notify ?? defaultNotify)();
    return l.done;
  });
  return l.finalizing;
}

/** The link's current state — the UI polls this while the owner approves in the browser. */
export type CliLinkStatus =
  | { status: 'pending' }
  | { status: 'completed'; account: AccountStatusRow | null }
  | { status: 'failed'; error: string }
  | { status: 'unknown' };
function localCliLinkStatus(linkId: string): CliLinkStatus {
  const l = links.get(linkId);
  if (!l) return { status: 'unknown' };
  if (!l.done) return { status: 'pending' };
  return l.done.ok ? { status: 'completed', account: l.done.account } : { status: 'failed', error: l.done.error };
}

/** Read on the PTY owner, rather than treating a sibling's empty Map as expiry. */
export async function getCliLinkStatus(linkId: string): Promise<CliLinkStatus> {
  const local = links.get(linkId);
  if (local) return local.workspaceId === activeWorkspaceId() ? localCliLinkStatus(linkId) : { status: 'unknown' };
  const owner = await locateOwnerRpcResource(CLI_LINK_RPC_KIND, linkId, cliLinkScope());
  if (!owner.ok) {
    // A lookup miss includes unknown/expired ids. A timeout proves neither expiry
    // nor owner loss, so leave the UI pending and allow its next status read.
    return owner.code === 'timeout' || owner.code === 'send_failed'
      ? { status: 'pending' }
      : storedCliLinkStatus(linkId);
  }
  const ownerPid = (owner.result as { ownerPid: number }).ownerPid;
  if (ownerPid === process.pid) return storedCliLinkStatus(linkId);
  const result = await callOwnerProcess({ targetPid: ownerPid, kind: CLI_LINK_RPC_KIND, payload: { op: 'status', linkId, workspaceId: activeWorkspaceId() } });
  if (result.ok) {
    const status = result.result as CliLinkStatus;
    return status.status === 'unknown' ? storedCliLinkStatus(linkId) : status;
  }
  if (result.code === 'timeout' || result.code === 'send_failed') return { status: 'pending' };
  return storedCliLinkStatus(linkId);
}

async function storedCliLinkStatus(linkId: string): Promise<CliLinkStatus> {
  try {
    const row = await readStoredCliLink(linkId, cliLinkScope());
    if (!row) return { status: 'unknown' };
    if (row.outcome === 'completed') {
      return { status: 'completed', account: (await accountStatus()).find(a => a.id === row.accountId) ?? null };
    }
    if (row.outcome === 'failed') return { status: 'failed', error: `account link ${row.failure ?? 'interrupted'} — complete the link to retry an approved Codex login` };
    if (row.expiresAt <= Date.now()) return { status: 'failed', error: 'account link expired — complete the link to recover an approved Codex login' };
    if (linkOwnerLiveness(row.owner) === 'dead') return { status: 'failed', error: 'account link owner interrupted — complete the link to recover an approved Codex login' };
    return { status: 'pending' };
  } catch {
    // Persistence failure is not evidence that a link expired. This reader never writes.
    return { status: 'pending' };
  }
}

type G = typeof globalThis & { __papercuspCliLinks?: Map<string, PendingCliLink> };
const g = globalThis as G;
const links: Map<string, PendingCliLink> = g.__papercuspCliLinks ?? new Map<string, PendingCliLink>();
g.__papercuspCliLinks = links;

function cleanup(linkId: string): void {
  const l = links.get(linkId);
  if (!l) return;
  links.delete(linkId);
  clearTimeout(l.reaper);
  if (l.enterTimer) clearTimeout(l.enterTimer);
  try {
    l.pty?.kill();
  } catch {
    /* already exited */
  }
  void rm(l.configDir, { recursive: true, force: true }).catch(() => {});
}

export interface StartCliLinkInput {
  accountId: string;
  label?: string;
  provider?: AccountProvider;
}
export type StartCliLinkResult =
  | { ok: true; authorizeUrl: string; linkId: string; provider: AccountProvider; userCode?: string }
  | { ok: false; error: string };
export interface StartCliLinkDeps {
  /** Override the wait for the CLI's authorize URL (ms). Tests inject a small value. */
  startTimeoutMs?: number;
}

/** Spawn the provider CLI and capture the browser-login URL it prints; hold the process. */
export async function startCliLink(input: StartCliLinkInput, deps: StartCliLinkDeps = {}): Promise<StartCliLinkResult> {
  const accountId = input.accountId?.trim();
  if (!accountId || !ID_RE.test(accountId)) {
    return { ok: false, error: 'accountId required (allowed: A-Za-z0-9 . _ -)' };
  }
  const provider = normalizeAccountProvider(input.provider);
  const workspaceId = activeWorkspaceId();
  const scope = cliLinkScope();
  const linkId = randomUUID();
  // Establish custody BEFORE launching the CLI: a relay failure must not create
  // an orphan login, or delete a completed credential while trying to unwind it.
  try {
    await bindOwnerRpcResource(CLI_LINK_RPC_KIND, linkId, cliLinkScope(), LINK_TTL_MS + DONE_GRACE_MS + 2 * START_TIMEOUT_MS);
  } catch {
    return { ok: false, error: 'could not establish account-link process custody — retry the add-account flow' };
  }
  const configDir = papercuspPath(
    'deploy-credentials',
    provider === 'codex'
      ? `.codex-setup-${accountId}-${randomBytes(4).toString('hex')}`
      : `.setup-${accountId}-${randomBytes(4).toString('hex')}`,
  );
  const linkOwner = newLinkOwner();
  try {
    await createStoredCliLink({ linkId, scope: cliLinkScope(), accountId,
      label: input.label?.trim() || undefined, provider, configDir, owner: linkOwner,
      createdAt: Date.now(), expiresAt: Date.now() + LINK_TTL_MS,
      retainUntil: Date.now() + LINK_RECOVERY_RETENTION_MS });
    await mkdir(configDir, { recursive: true });
  } catch {
    return { ok: false, error: 'could not persist account-link custody — no login was started' };
  }
  let bin: string;
  let pty: IPty;
  try {
    bin = resolveCliBin(provider);
    const spawnEnv = {
      ...process.env,
      PATH: cliSpawnPath(bin),
      ...(provider === 'codex' ? { CODEX_HOME: configDir } : { CLAUDE_CONFIG_DIR: configDir }),
    };
    pty = provider === 'codex'
      ? spawn(bin, ['login', '--device-auth'], {
        name: 'xterm-256color',
        cols: 4000,
        rows: 50,
        cwd: configDir,
        env: spawnEnv,
      })
      : spawn(bin, ['setup-token'], {
      name: 'xterm-256color',
      cols: 4000, // ultra-wide → the long URL + token never wrap (a wrapped line breaks the regex)
      rows: 50,
      cwd: configDir,
      env: spawnEnv,
    });
  } catch (e) {
    await finishStoredCliLink(linkId, cliLinkScope(), linkOwner.nonce, 'failed', 'start-failed');
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `couldn't launch the ${providerLabel(provider)} CLI: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  const entry: PendingCliLink = {
    workspaceId,
    scope,
    pty,
    owner: linkOwner,
    buf: '',
    accountId,
    label: input.label?.trim() || undefined,
    provider,
    configDir,
    reaper: setTimeout(() => reapCliLink(linkId), LINK_TTL_MS),
  };
  links.set(linkId, entry);
  // ONE persistent listener owns appending to entry.buf; every readUntil below only OBSERVES
  // (no-op appender). With multiple appending listeners each chunk would land twice.
  pty.onData((d) => {
    entry.buf += d;
  });
  // Codex writes auth.json and exits after browser approval. Install that login
  // immediately: requiring a later "complete" call leaves a successful login in
  // the temporary home, where the pending-link reaper can delete it.
  if (provider === 'codex') {
    pty.onExit(({ exitCode }) => {
      if (exitCode === 0 && links.get(linkId) === entry) {
        void finalizeCodexCliLink(linkId, entry, {}, { notify: defaultNotify });
      }
    });
  }
  const noAppend = () => {};

  const startTimeoutMs = deps.startTimeoutMs ?? START_TIMEOUT_MS;
  const url = await readUntil(pty, () => entry.buf, noAppend, provider === 'codex' ? CODEX_URL_RE : URL_RE, startTimeoutMs);

  if (!url) {
    // Surface WHY: the CLI's own output tail (a real failure explains itself), or — when the pty
    // produced nothing — the resolved binary, so a missing/broken install is named, not guessed at.
    const tail = stripAnsi(entry.buf).replace(/\s+/g, ' ').trim().slice(-200);
    await finishStoredCliLink(linkId, cliLinkScope(), entry.owner.nonce, 'failed', 'start-failed');
    cleanup(linkId);
    return {
      ok: false,
      error: tail
        ? `the ${providerLabel(provider)} CLI did not produce an authorize URL — CLI output: "${tail}"`
        : `the ${providerLabel(provider)} CLI produced no output (tried \`${bin}\` — is it installed and executable on this operator host? A stripped service PATH is the usual cause)`,
    };
  }
  if (provider === 'codex') {
    const userCode = await readUntil(pty, () => entry.buf, noAppend, CODEX_USER_CODE_RE, startTimeoutMs);
    if (!userCode) {
      await finishStoredCliLink(linkId, cliLinkScope(), entry.owner.nonce, 'failed', 'start-failed');
      cleanup(linkId);
      return { ok: false, error: 'the Codex CLI did not produce a device code' };
    }
    return { ok: true, authorizeUrl: url, linkId, provider, userCode };
  }
  // claude CLI ≥2.1.200 same-machine auto-callback (see PendingCliLink.done): the CLI can mint
  // the token WITHOUT any pasted code. Watch the held pty in the background and finalize the
  // moment the token appears, so the owner's "You're all set up — close this window" path
  // actually lands the account. The remote-browser paste path still flows through
  // completeCliLink; finalization is idempotent (entry.finalizing), so the two can race safely.
  void (async () => {
    const m = await readUntil(pty, () => entry.buf, noAppend, TOKEN_RE, LINK_TTL_MS);
    const token = m?.match(TOKEN_RE)?.[0];
    if (token && links.get(linkId) === entry) {
      await finalizeClaudeToken(linkId, entry, token, undefined, {});
    }
  })();
  return { ok: true, authorizeUrl: url, linkId, provider };
}

export interface CompleteCliLinkInput {
  linkId: string;
  code?: string;
  workspace?: string;
}
export interface CompleteCliLinkDeps {
  notify?: () => void;
  /** Override the post-paste Enter delay (ms). Tests inject a small value. */
  enterDelayMs?: number;
}
export type CompleteCliLinkResult = { ok: true; account: AccountStatusRow | null } | { ok: false; error: string };

function defaultNotify(): void {
  void trackDetached(import('../sync-sse'))
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
    .catch(() => {});
}

function providerLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

async function completeCodexCliLink(
  linkId: string,
  l: PendingCliLink,
  _input: CompleteCliLinkInput,
  deps: CompleteCliLinkDeps,
): Promise<CompleteCliLinkResult> {
  const sourceAuthPath = `${l.configDir}/auth.json`;
  let raw: string;
  try {
    raw = await readFile(sourceAuthPath, 'utf8');
  } catch {
    return { ok: false, error: 'Codex login is not complete yet — enter the device code in the browser, then complete the link' };
  }
  try {
    const auth = JSON.parse(raw) as { auth_mode?: string; tokens?: { access_token?: string } };
    if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token?.trim()) {
      return { ok: false, error: 'Codex login did not produce a usable ChatGPT credential' };
    }
  } catch {
    return { ok: false, error: 'Codex login produced an invalid credential file' };
  }
  const durableHome = `${l.scope}/${l.accountId}.codex-cli`;
  const durableAuthPath = `${durableHome}/auth.json`;
  try {
    await rm(durableHome, { recursive: true, force: true });
    await mkdir(durableHome, { recursive: true });
    await writeFile(durableAuthPath, raw, { mode: 0o600 });
    await chmod(durableAuthPath, 0o600);
    // Preserve any provider-managed side files the CLI created alongside auth.json.
    await cp(l.configDir, durableHome, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (src) => src !== sourceAuthPath,
    }).catch(() => {});
    await updateAccountPool((p) =>
      registerAccount(
        p,
        {
          id: l.accountId,
          provider: 'codex',
          credentialRef: `codex-cli:${durableHome}`,
          label: l.label,
        },
        Date.now(),
      ), l.workspaceId,
    );
  } catch (e) {
    return { ok: false, error: `failed to persist the Codex CLI credential: ${(e as Error).message}` };
  }
  const account = (await accountStatus(l.workspaceId)).find((a) => a.id === l.accountId) ?? null;
  return {
    ok: true,
    account,
  };
}

/** One finalizer for automatic device approval, explicit completion and expiry. */
function finalizeCodexCliLink(
  linkId: string,
  l: PendingCliLink,
  input: Partial<CompleteCliLinkInput>,
  deps: CompleteCliLinkDeps,
): Promise<CompleteCliLinkResult> {
  if (l.done?.ok) return Promise.resolve(l.done);
  l.done = undefined;
  if (l.finalizing) return l.finalizing;
  const attempt = runWithWorkspace(l.workspaceId, () => Promise.resolve().then(async (): Promise<CompleteCliLinkResult> => {
    const held = await readStoredCliLink(linkId, l.scope);
    if (held?.owner.nonce !== l.owner.nonce) return { ok: false, error: 'account-link custody changed; approved credentials were preserved' };
    return completeCodexCliLink(linkId, l, { linkId, ...input }, deps);
  })
    .then(async (result) => {
      if (!result.ok) {
        await finishStoredCliLink(linkId, l.scope, l.owner.nonce, 'failed', 'registration-failed');
        return result;
      }
      if (!await finishStoredCliLink(linkId, l.scope, l.owner.nonce, 'completed')) {
        return { ok: false, error: 'account-link custody changed; approved credentials were preserved' } as CompleteCliLinkResult;
      }
      l.done = result;
      clearTimeout(l.reaper);
      try { l.pty?.kill(); } catch { /* already exited */ }
      void rm(l.configDir, { recursive: true, force: true }).catch(() => {});
      l.reaper = setTimeout(() => links.delete(linkId), DONE_GRACE_MS);
      (deps.notify ?? defaultNotify)();
      return result;
    })
    .catch((): CompleteCliLinkResult => ({ ok: false, error: 'failed to finalize the Codex login' }))
    .finally(() => { if (l.finalizing === attempt) l.finalizing = undefined; }));
  l.finalizing = attempt;
  return attempt;
}

/** A completed credential must be installed before its temporary home is removed. */
function reapCliLink(linkId: string): void {
  void trackDetached(expireCliLink(linkId)).catch(() => {
    const l = links.get(linkId);
    if (!l) return;
    // A failed metadata write must neither crash the host nor discard the approved home.
    l.done = { ok: false, error: 'account-link expiry could not be recorded; credentials preserved — retry completion' };
    defaultNotify();
  });
}

async function expireCliLink(linkId: string): Promise<void> {
  const l = links.get(linkId);
  if (!l) return;
  return runWithWorkspace(l.workspaceId, async () => {
  if (l.provider === 'codex') {
    const result = await finalizeCodexCliLink(linkId, l, {}, {});
    if (result.ok) return;
    // An unapproved flow has no auth.json and can be discarded. Preserve a
    // completed login when registration failed so a later completion can retry.
    try {
      await readFile(`${l.configDir}/auth.json`, 'utf8');
      l.done = result;
      return;
    } catch { /* no completed login to preserve */ }
  }
  await finishStoredCliLink(linkId, l.scope, l.owner.nonce, 'failed', 'expired');
  cleanup(linkId);
  });
}

/** Feed the pasted code into the held CLI when needed, capture the credential, write + register it. */
async function completeLocalCliLink(input: CompleteCliLinkInput, deps: CompleteCliLinkDeps = {}): Promise<CompleteCliLinkResult> {
  const l = links.get(input.linkId);
  if (!l) return { ok: false, error: 'link expired or unknown — restart the add-account flow' };
  if (l.done && (l.done.ok || l.provider !== 'codex')) {
    // The ≥2.1.200 auto-callback already finalized this link (no code ever shown to the owner).
    const done = l.done;
    clearTimeout(l.reaper);
    links.delete(input.linkId);
    return done;
  }
  if (l.provider === 'codex') return finalizeCodexCliLink(input.linkId, l, input, deps);
  if (!l.pty) return { ok: false, error: 'the original Claude handshake was interrupted' };
  const pty = l.pty;
  const code = input.code?.trim();
  if (!code) {
    return {
      ok: false,
      error:
        'code required — paste the value claude.ai showed. (If claude said "You\'re all set up" with NO code, the link completes automatically: give it a few seconds and check the account list.)',
    };
  }

  // Do NOT reset l.buf here: with the ≥2.1.200 auto-callback the minted token may ALREADY be in
  // the buffer, and OUTCOME_RE matching it immediately is exactly right. Register the listener,
  // paste the code, THEN press Enter as a SEPARATE write after a short settle (the Ink TUI
  // swallows a CR appended to the paste — see SUBMIT_ENTER_DELAY_MS). Settle on the token OR a
  // rejection line (OUTCOME_RE) so a bad code fails fast.
  const enterDelay = deps.enterDelayMs ?? SUBMIT_ENTER_DELAY_MS;
  const matched = await readUntil(
    pty,
    () => l.buf,
    () => {},
    OUTCOME_RE,
    COMPLETE_TIMEOUT_MS,
    () => {
      try {
        pty.write(code);
      } catch {
        /* pty already gone (auto-mint exited it) — the buffer check above still settles */
      }
      l.enterTimer = setTimeout(() => {
        try {
          pty.write('\r');
        } catch {
          /* pty already gone */
        }
      }, enterDelay);
    },
  );
  const token = matched && TOKEN_RE.test(matched) ? (matched.match(TOKEN_RE)?.[0] ?? null) : null;

  if (!token) {
    // The background watcher may have finalized while we waited — report THAT, not a failure.
    if (l.done) {
      const done = l.done;
      clearTimeout(l.reaper);
      links.delete(input.linkId);
      return done;
    }
    const tail = stripAnsi(l.buf).replace(/\s+/g, ' ').trim().slice(-180);
    await finishStoredCliLink(input.linkId, cliLinkScope(), l.owner.nonce, 'failed', 'interrupted');
    cleanup(input.linkId);
    const said = tail ? ` — claude said: "${tail}"` : '';
    return {
      ok: false,
      error: matched
        ? `claude rejected the code (it may be expired, already used, or for a different account)${said} — restart the add-account flow`
        : `claude did not return a token${said || ' (the code may be expired/invalid — restart the flow)'}`,
    };
  }

  const result = await finalizeClaudeToken(input.linkId, l, token, input.workspace, deps);
  // Explicit completion — the caller has the outcome; no grace window needed.
  const still = links.get(input.linkId);
  if (still) {
    clearTimeout(still.reaper);
    links.delete(input.linkId);
  }
  return result;
}

/** Completion must write to the same PTY that started the provider handshake. */
export async function completeCliLink(input: CompleteCliLinkInput, deps: CompleteCliLinkDeps = {}): Promise<CompleteCliLinkResult> {
  const local = links.get(input.linkId);
  const workspaceId = activeWorkspaceId();
  if (input.workspace && input.workspace !== workspaceId) return { ok: false, error: 'account-link workspace mismatch' };
  if (local) return local.workspaceId === workspaceId
    ? runWithWorkspace(local.workspaceId, () => completeLocalCliLink(input, deps))
    : { ok: false, error: 'account-link workspace mismatch' };
  const owner = await locateOwnerRpcResource(CLI_LINK_RPC_KIND, input.linkId, cliLinkScope());
  if (!owner.ok) return owner.code === 'owner_gone' || owner.code === 'not_clustered'
    ? recoverStoredCliLink(input, deps)
    : { ok: false, error: `link owner unavailable (${owner.code}) — no replacement login was started` };
  const ownerPid = (owner.result as { ownerPid: number }).ownerPid;
  if (ownerPid === process.pid) return recoverStoredCliLink(input, deps);
  const result = await callOwnerProcess({
    targetPid: ownerPid, kind: CLI_LINK_RPC_KIND,
    payload: { op: 'complete', ...input, workspaceId }, timeoutMs: COMPLETE_TIMEOUT_MS + 5_000,
  });
  if (result.ok) return result.result as CompleteCliLinkResult;
  return result.code === 'owner_gone' ? recoverStoredCliLink(input, deps)
    : { ok: false, error: `link owner unavailable (${result.code}) — no replacement login was started` };
}

/** Write path only. No new login, no time-based stealing, no cleanup before successful commit. */
async function recoverStoredCliLink(input: CompleteCliLinkInput, deps: CompleteCliLinkDeps): Promise<CompleteCliLinkResult> {
  let row: StoredCliLink | null;
  try { row = await readStoredCliLink(input.linkId, cliLinkScope()); }
  catch { return { ok: false, error: 'account-link custody could not be read; retry completion' }; }
  if (!row) return { ok: false, error: 'link expired or unknown — no replacement login was started' };
  if (row.outcome === 'completed') {
    return { ok: true, account: (await accountStatus()).find(a => a.id === row.accountId) ?? null };
  }
  if (row.provider !== 'codex' || linkOwnerLiveness(row.owner) !== 'dead') {
    return { ok: false, error: 'original account-link owner is live or unverified, or the provider handshake cannot be recovered' };
  }
  let claimed: StoredCliLink | null;
  try { claimed = await claimStoredCliLink(row, newLinkOwner()); }
  catch { return { ok: false, error: 'account-link recovery custody unavailable; retry completion' }; }
  if (!claimed) return { ok: false, error: 'account-link recovery already has a custodian' };
  const l: PendingCliLink = {
    workspaceId: activeWorkspaceId(), scope: claimed.scope,
    pty: null, buf: '', accountId: claimed.accountId, label: claimed.label,
    provider: claimed.provider, configDir: claimed.configDir, owner: claimed.owner,
    reaper: setTimeout(() => reapCliLink(input.linkId), LINK_TTL_MS),
  };
  links.set(input.linkId, l);
  // If approval never completed, the maintained finalizer reports that precisely.
  // Approved auth remains in place on registration/persistence failure for retry.
  return finalizeCodexCliLink(input.linkId, l, input, deps);
}

registerOwnerRpcHandler(CLI_LINK_RPC_KIND, async (payload) => {
  const p = payload as Partial<CompleteCliLinkInput> & { op?: unknown; workspaceId?: unknown } | null;
  if (!p || typeof p.linkId !== 'string' || !p.linkId ||
      (p.op !== 'status' && p.op !== 'complete') ||
      (p.code !== undefined && typeof p.code !== 'string') ||
      (p.workspace !== undefined && typeof p.workspace !== 'string') ||
      typeof p.workspaceId !== 'string') {
    throw new Error('invalid account link operation');
  }
  // Never re-route here: a stale mapping must not cause a forwarding loop.
  const local = links.get(p.linkId);
  if (!local || local.workspaceId !== p.workspaceId || (p.workspace && p.workspace !== local.workspaceId)) {
    return p.op === 'status' ? { status: 'unknown' } : { ok: false, error: 'account-link workspace mismatch' };
  }
  return runWithWorkspace(local.workspaceId, () => p.op === 'status' ? localCliLinkStatus(p.linkId!)
    : completeLocalCliLink({ linkId: p.linkId!, code: p.code, workspace: local.workspaceId }));
});

/** Test-only: drop all held links (kills the ptys). */
export function __resetCliLinksForTest(): void {
  for (const id of [...links.keys()]) cleanup(id);
}
