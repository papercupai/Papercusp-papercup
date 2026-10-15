/**
 * POST /adv/sessions/launch-su — the HEADLESS contract (WI-6505).
 *
 * WHY THIS FILE EXISTS: the GUI's fleet-launch row (FleetLaunchRow.tsx) offers a
 * headed/headless picker, and its own tests mock `launchAgent` — so they prove the
 * UI SENDS `headless: true` and nothing more. Until this file, NOTHING verified
 * that the server ACTS on it. That gap is the exact hazard the feature's author
 * flagged: "DO NOT ship a headless control that silently launches HEADED
 * sessions." Delete the `--headless` push or the `spawnHeadless` branch and every
 * other test in the repo stays green while the row quietly opens windows.
 *
 * So the assertions here are deliberately about the FORK, not the happy path:
 * which spawn helper ran, which one did NOT, and that the two argvs differ by
 * exactly one token. A test that only checked "headless returns 200" would pass
 * against a server that ignored the flag entirely.
 *
 * Hermetic: every spawn/DB/workspace leaf is mocked (mirroring the pattern in
 * native-session-id-roundtrip.test.ts), but `shellEscape` is the REAL one so the
 * asserted command line is the one that would actually be executed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';
// WI-37841: the READER's derivation. Imported (not re-typed) so the receipt
// assertion below fails if the writer and reader ever drift apart.
import { psuLaunchLogPath } from '../../../psu-launch-log.mjs';

// Both mocks DECLARE their parameter so `.mock.calls[0][0]` is typed — that call
// argument is the whole assertion surface here (it carries the composed argv).
const spawnInTerminalMock = vi.fn(async (_opts: { oneliner: string; env: NodeJS.ProcessEnv }) => ({
  ok: true as const,
  terminal: 'xterm',
  pid: 4242 as number | undefined,
  likelyOpened: true,
}));
const spawnHeadlessMock = vi.fn(
  async (_opts: { envelope: { greetingCmd: string; cwd: string; env?: NodeJS.ProcessEnv }; label: string; logDir: string }) => ({
    status: 'ok' as string,
    terminal: 'headless (log: /tmp/fleet-logs/x.log)',
    pid: 5151 as number | undefined,
    error: '' as string,
  }),
);
const spawnHostUrlMock = vi.hoisted(() => vi.fn(() => 'http://localhost:3070'));
const attachedMock = vi.fn(async (_request: Request, _input: unknown) => Response.json({ status: 'ok', transport: 'structured' }));
const durableMock = vi.fn();
const getSessionMock = vi.fn();
vi.mock('../../../su-session-persistence', () => ({ readDurableSuSession: (...args: unknown[]) => durableMock(...args) }));
vi.mock('../../../su-session-attached-launch', () => ({ launchAttachedSuSession: (request: Request, input: unknown) => attachedMock(request, input) }));

// `shellEscape` stays REAL (importOriginal): the oneliner we assert on is then
// byte-for-byte the command the spawn helper would have run.
vi.mock('../../../terminal-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../terminal-spawn')>();
  return {
    ...actual,
    isOnPath: () => true,
    spawnInTerminal: (o: any) => spawnInTerminalMock(o),
  };
});
// `keepWindowOpenOnFailure` stays REAL (importOriginal) for the same reason
// `shellEscape` does below: it is a pure string builder, and the headed
// one-liner these tests assert on is only meaningful if it is the one the route
// would actually run. Mocking the module WHOLESALE — as this did before
// WI-37743 — replaces every export, so a newly imported one silently becomes
// `undefined` and the headed path dies with a TypeError that looks nothing like
// the missing-mock it is.
vi.mock('../../../console-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../console-spawn')>()),
  spawnHeadless: (o: any) => spawnHeadlessMock(o),
}));
vi.mock('../../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/workspace',
    env: {},
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
vi.mock('../../../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/pc' }));
vi.mock('../../../mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: () => spawnHostUrlMock(),
  resolveLongLivedSessionMcpBaseUrl: () => 'http://127.0.0.1:9071',
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../../interactive-safety-floor', () => ({
  checkInteractiveSafetyFloor: vi.fn(async () => ({ ok: true as const })),
}));
// WI-37743: setAdvSessionPid / markAdvSessionEnded are stubbed for the same
// reason recordAdvSession is. The route now writes its row BEFORE the spawn and
// stamps/closes it after, so both are on the hot path — and because this mock
// spreads importOriginal, anything NOT named here resolves to the REAL PG
// writer. That would reach `getOrgPg()` with no database, whose failure path
// console.warn's, and operator-core's vitest is fail-on-console: a route unit
// test would go red for touching a DB it has no business touching.
const setAdvSessionPidMock = vi.fn(async () => {});
const markAdvSessionEndedMock = vi.fn(async () => {});
vi.mock('../../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../../adv-sessions')>()),
  DISPLAY_TERMINAL_LAUNCH: 'terminal',
  recordAdvSession: vi.fn(async () => 7 as number | null),
  getAdvSession: (...args: unknown[]) => getSessionMock(...args),
  setAdvSessionPid: (...a: unknown[]) => setAdvSessionPidMock(...(a as [])),
  markAdvSessionEnded: (...a: unknown[]) => markAdvSessionEndedMock(...(a as [])),
}));
// Returns a PROMISE: the route fires it as `void notifySyncInvalidate(...).catch(...)`,
// so a bare vi.fn() (undefined) throws inside the handler.
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function launch(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const mod = await import('./launch-su');
  const post = (mod.default as unknown as Route[]).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/adv/sessions/launch-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'claude', harness_slug: null, plan_slug: null, ...body }),
  });
  const res = await post.handler(req, CTX);
  return { status: res.status, json: await res.json() };
}

/** The command line the route would actually execute, from whichever helper ran. */
function headedOneliner(): string {
  return spawnInTerminalMock.mock.calls[0]![0].oneliner;
}
function headlessOneliner(): string {
  return spawnHeadlessMock.mock.calls[0]![0].envelope.greetingCmd;
}
/** Decode one shellEscape()-produced single shell word without executing it. */
function decodeShellWord(word: string): string {
  if (!word.startsWith("'") || !word.endsWith("'")) {
    throw new Error(`expected a shellEscape() single word, got: ${word}`);
  }
  return word.slice(1, -1).replace(/'\\''/g, "'");
}

/**
 * The interactive rcfile script inside WI-40182's terminal-holding bash.
 * Decoding both wrapper layers keeps these assertions structural: a test that
 * merely searched the twice-escaped outer string could pass while the script
 * handed to bash was malformed.
 */
function headedInteractiveScript(): string {
  const oneliner = headedOneliner();
  const m = /^exec bash --noprofile --rcfile <\(printf '%s\\n' (.+)\) -i$/s.exec(oneliner);
  if (!m) throw new Error(`headed one-liner is not in keep-open form: ${oneliner}`);
  return decodeShellWord(m[1]!);
}

/**
 * The psu command inside the headed wrapper, decoded back to what the rcfile
 * evals so it can be compared token-for-token with the headless form.
 */
function headedPsuCommand(script = headedInteractiveScript()): string {
  // The eval is either the greeting itself or a command inside the bounded
  // stderr-capture group. Decode its shell word, never the outer escaped text.
  const commands = [...script.matchAll(/(?:^|; )\(eval ('(?:[^']|'\\'')*')\)(?=;| 2>&4 3>&- 4>&-)/gs)];
  if (commands.length !== 1) throw new Error(`headed rcfile script does not eval exactly one psu command: ${script}`);
  return decodeShellWord(commands[0]![1]!);
}
/** `--owner-id=su-<uuid>` is freshly minted per launch, so normalise it to diff two argvs. */
const normaliseOwner = (s: string): string => s.replace(/--owner-id=su-[0-9a-f-]+/i, '--owner-id=<pinned>');

beforeEach(() => {
  durableMock.mockReset();
  getSessionMock.mockReset();
  vi.clearAllMocks();
  spawnHostUrlMock.mockReturnValue('http://localhost:3070');
});

describe('launch-su — headless routes to spawnHeadless, headed to spawnInTerminal (WI-6505)', () => {
  it('pins a current-build headless child to the operator that selected its identity', async () => {
    spawnHostUrlMock.mockReturnValue('http://localhost:33700');
    const { buildConsoleEnvelope } = await import('../../../console-launcher');
    const result = await launch({ headless: true, stack: ['composition:native-composition'],
      selected_identity_revision: 'a'.repeat(64) });
    expect(result.status).toBe(200);
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      operatorBaseUrl: 'http://localhost:33700',
      agentMcpBaseUrl: 'http://localhost:33700',
    }));
    expect(headlessOneliner()).toContain('--stack=composition:native-composition');
  });

  it('keeps green-main headless children on the existing long-lived proxy', async () => {
    const { buildConsoleEnvelope } = await import('../../../console-launcher');
    const result = await launch({ headless: true });
    expect(result.status).toBe(200);
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      operatorBaseUrl: 'http://localhost:3070',
    }));
    expect(vi.mocked(buildConsoleEnvelope).mock.calls[0]?.[0]).not.toHaveProperty('agentMcpBaseUrl');
  });

  it('starts PUI through the structured SU branch without either native launcher', async () => {
    const result = await launch({ attached_engine: true, agent_chat_id: 'chat', harness_slug: 'papercusp', account: 'default', carry: 'warm' });
    expect(result).toMatchObject({ status: 200, json: { transport: 'structured' } });
    expect(attachedMock).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ agent: 'claude', agent_chat_id: 'chat', harness_slug: 'papercusp', account: 'default', carry: 'warm' }));
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  // WI-10004158 / D-011: an OMP gateway model runs only on the gateway, so an
  // omitted account follows it to `auto`; the default account would refuse it.
  it.each([
    ['papercusp-gateway/claude-sonnet-4-6', 'auto'],
    ['openai-codex/gpt-5.6-terra', 'default'],
  ])('an omitted OMP account follows model %s to %s', async (model, account) => {
    vi.stubEnv('PAPERCUSP_OMP_MODEL_SELECTOR', '');
    try {
      const result = await launch({ attached_engine: true, agent: 'omp', agent_chat_id: 'chat', harness_slug: 'papercusp', model, carry: 'warm' });
      expect(result).toMatchObject({ status: 200, json: { transport: 'structured' } });
      expect(attachedMock).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ agent: 'omp', model, account }));
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps an explicit default account even for an OMP gateway model', async () => {
    const model = 'papercusp-gateway/claude-sonnet-4-6';
    const result = await launch({ attached_engine: true, agent: 'omp', agent_chat_id: 'chat', harness_slug: 'papercusp', model, account: 'default', carry: 'warm' });
    expect(result).toMatchObject({ status: 200 });
    expect(attachedMock).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ agent: 'omp', model, account: 'default' }));
  });

  it.each([{ defer_spawn: true }, { headless: true }, { resume_session_id: 'native-id' }])('rejects conflicting attached/native launch modes %j', async (conflict) => {
    expect((await launch({ attached_engine: true, agent_chat_id: 'chat', harness_slug: 'papercusp', ...conflict })).status).toBe(400);
    expect(attachedMock).not.toHaveBeenCalled();
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('routes the PUI conversation-picker attach through structured recovery', async () => {
    getSessionMock.mockResolvedValue({ id: 7, agent: 'claude', workspaceId: 'default',
      harnessSlug: 'papercusp', planSlug: null, coordOwnerId: 'saved-owner' });
    durableMock.mockResolvedValue({ agentChatId: 'saved-chat', harnessSlug: 'papercusp',
      descriptor: { accountRoute: 'saved-account', carry: 'cold', model: 'saved-model' } });
    expect(await launch({ attach_adv_session_id: 7, harness_slug: 'papercusp' }))
      .toMatchObject({ status: 200, json: { transport: 'structured' } });
    expect(attachedMock).toHaveBeenCalledWith(expect.any(Request), { agent: 'claude', agent_chat_id: 'saved-chat',
      harness_slug: 'papercusp', account: 'saved-account', carry: 'cold', model: 'saved-model' });
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('headless:true spawns HEADLESS and never opens a terminal', async () => {
    const { status, json } = await launch({ headless: true });
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
    // The whole point: the headed path must not have run.
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    expect(headlessOneliner()).toContain('--headless');
  });

  it('carries the selected identity source pin into psu and refuses malformed selections before spawn', async () => {
    const revision = 'a'.repeat(64);
    const invalid = await launch({ stack: ['domain:research-steward'], selected_identity_revision: 'stale' });
    expect(invalid.status).toBe(400);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    const exact = await launch({ headless: true, stack: ['domain:research-steward'],
      selected_identity_revision: revision });
    expect(exact.status).toBe(200);
    expect(headlessOneliner()).toContain('--stack=domain:research-steward');
    expect(headlessOneliner()).toContain(`--identity-revision=${revision}`);
  });

  it('headless:false spawns a TERMINAL and passes no --headless flag', async () => {
    const { status, json } = await launch({ headless: false });
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
    expect(spawnInTerminalMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(headedOneliner()).not.toContain('--headless');
  });

  it('an OMITTED headless flag is headed — the null-safe default', async () => {
    await launch({});
    expect(spawnInTerminalMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(headedOneliner()).not.toContain('--headless');
  });

  it('kickoff_prompt rides the spawn-safe PAPERCUSP_KICKOFF_PROMPT env into BOTH spawn shapes (P-017)', async () => {
    await launch({ headless: true, kickoff_prompt: 'GOAL brief: keep draining' });
    expect(spawnHeadlessMock.mock.calls[0]![0].envelope.env?.PAPERCUSP_KICKOFF_PROMPT).toBe(
      'GOAL brief: keep draining',
    );
    // Never an argv token — free text inside a greeting oneliner breaks quoting
    // (the exact reason resolveKickoffText has an env fallback).
    expect(headlessOneliner()).not.toContain('kickoff');

    vi.clearAllMocks();
    await launch({ kickoff_prompt: 'headed brief' });
    expect(spawnInTerminalMock.mock.calls[0]![0].env.PAPERCUSP_KICKOFF_PROMPT).toBe('headed brief');
    expect(headedOneliner()).not.toContain('kickoff');
  });

  it('an omitted or blank kickoff_prompt sets no env var', async () => {
    await launch({ headless: true, kickoff_prompt: '   ' });
    const env = spawnHeadlessMock.mock.calls[0]![0].envelope.env ?? {};
    expect('PAPERCUSP_KICKOFF_PROMPT' in env).toBe(false);
  });

  /**
   * The source comments claim `--headless` is pushed LAST so the argv is
   * "otherwise byte-identical" to a headed launch. That claim is load-bearing —
   * it is what makes the headless path trustworthy as the same launch — so it is
   * asserted rather than believed.
   */
  it('the headless argv is the headed argv plus exactly one trailing token', async () => {
    await launch({ harness_slug: 'papercusp', plan_slug: 'some-plan', model: 'sonnet', headless: false });
    // Compare the psu COMMANDS, not the one-liners: since WI-37743 the headed
    // one is wrapped to keep the window open on failure, while headless (no
    // window) keeps the bare `exec`. The argv parity claim is about psu's argv.
    const headed = normaliseOwner(headedPsuCommand());
    vi.clearAllMocks();
    await launch({ harness_slug: 'papercusp', plan_slug: 'some-plan', model: 'sonnet', headless: true });
    const headless = normaliseOwner(headlessOneliner()).replace(/^exec /, '');

    // Every token goes through the REAL shellEscape, so the appended flag is quoted.
    expect(headless).toBe(`${headed} '--headless'`);
    expect(headless.match(/--headless/g)).toHaveLength(1);
  });

  // WI-10004787: launched_by is the ONLY way a server-side launcher (the
  // goal-drain-fleet watchdog) can hand bootstrap-su the owner whose goal the new
  // session inherits. Dropping it again strands every relaunched drain worker
  // with goal_id NULL on all of its tool calls.
  it('forwards launched_by as exactly one --launched-by token, and omits it when unset', async () => {
    await launch({ headless: true, launched_by: 'su-holder-1' });
    const withLauncher = headlessOneliner();
    expect(withLauncher.match(/--launched-by=su-holder-1/g)).toHaveLength(1);
    vi.clearAllMocks();
    await launch({ headless: true });
    expect(headlessOneliner()).not.toContain('--launched-by');
  });

  it.each([['su holder; rm -rf /'], [42]])('rejects a launched_by that is not an owner id (%j)', async (bad) => {
    const { status, json } = await launch({ headless: true, launched_by: bad });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('launched_by');
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('a headless spawn FAILURE is reported as an error — never a silent headed fallback', async () => {
    spawnHeadlessMock.mockResolvedValueOnce({
      status: 'error',
      terminal: '',
      pid: undefined,
      error: 'boom: died at boot',
    });
    const { status, json } = await launch({ headless: true });
    expect(status).toBe(500);
    expect(json.status).toBe('error');
    expect(String(json.error)).toContain('boom: died at boot');
    // The failure must NOT be papered over by quietly opening a window instead.
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
  });

  /**
   * WI-37743. The headed one-liner used to be a bare `exec <psu …>`, so psu
   * REPLACED the shell: any boot refusal — the 409 this bug actually was, a bad
   * operator URL, a missing token — closed the window the same instant it
   * printed the reason. The owner saw a terminal flash and a session stuck on
   * "Starting up", and recovering the message that had been on screen all along
   * cost a session of process archaeology.
   *
   * The three properties below are what make the failure readable, and each is
   * independently losable by a well-meaning edit.
   */
  it('the headed one-liner keeps the window open when psu exits non-zero', async () => {
    await launch({ headless: false });
    const cmd = headedOneliner();

    const script = headedInteractiveScript();

    // (1) the outer exec installs a genuinely interactive bash supervisor;
    //     the psu command itself is still EVAL'd inside that rcfile rather than
    //     exec'd, so Ctrl+C cannot kill the terminal-holding shell with it.
    expect(cmd).toMatch(/^exec bash --noprofile --rcfile /);
    expect(script).toMatch(/^\(exec 3> >\(umask 077; tail -c 16384 >> '/);
    expect(headedPsuCommand()).toContain('psu');

    // (2) the separators are `;`, never `&&` — with `&&` a non-zero psu exit
    //     short-circuits past the banner AND the trailing shell, which is
    //     precisely the failure case the window is being held open FOR.
    expect(script).toContain('__papercusp_boot_rc=$?;');
    expect(script).toContain('(exit "$__papercusp_boot_rc")); __papercusp_greeting_rc=$?;');
    expect(script).not.toMatch(/&&\s*exec/);

    // (3) a trailing interactive login shell is what actually holds it open.
    expect(script).toMatch(/exec "\$\{SHELL:-\/bin\/bash\}" -l\s*$/);
  });

  it('the HEADLESS one-liner keeps the bare exec (no window to hold open)', async () => {
    // The mirror of the test above, and not a redundant restatement of it: the
    // keep-open wrapper ends in `exec "$SHELL" -l`, which in a headless child
    // would leave an immortal login shell behind after psu exits instead of
    // letting the process finish. The wrapper belongs to the WINDOW, not to psu.
    await launch({ headless: true });
    const cmd = headlessOneliner();
    expect(cmd).toMatch(/^exec /);
    expect(cmd).not.toContain('__papercusp_greeting_rc');
    expect(cmd).not.toContain('SHELL:-/bin/bash');
  });

  it('refuses a missing, malformed, or ambiguous headed eval command', async () => {
    await launch({ headless: false });
    const script = headedInteractiveScript();
    expect(() => headedPsuCommand(script.replace('(eval ', '(exec '))).toThrow('exactly one psu command');
    expect(() => headedPsuCommand("(eval 'unterminated); __papercusp_greeting_rc=$?;")).toThrow('exactly one psu command');
    expect(() => headedPsuCommand(script + "; (eval 'second command');")).toThrow('exactly one psu command');
  });

  it('carries the fleet flag into a headless launch (the GUI fleet-launch row’s case)', async () => {
    // Members 2..N of a GUI fleet launch join by slug; a headless fleet member
    // must carry BOTH --fleet and --headless or the row silently splits the fleet
    // or opens windows the user asked not to see.
    await launch({ fleet: 'my-fleet', headless: true });
    const cmd = headlessOneliner();
    expect(cmd).toContain('--fleet=my-fleet');
    expect(cmd).toContain('--headless');
  });
});

describe('launch-su — the terminal child gets a stable session MCP base', () => {
  const ORIGINAL = process.env.PAPERCUSP_OPERATOR_URL;
  const ORIGINAL_HONO_PORT = process.env.PAPERCUSP_HONO_PORT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = ORIGINAL;
    if (ORIGINAL_HONO_PORT === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = ORIGINAL_HONO_PORT;
  });

  /** The env the route actually handed the terminal. */
  const headedEnv = (): NodeJS.ProcessEnv => spawnInTerminalMock.mock.calls[0]![0].env;

  it('points the keep-open receipt at THIS launch\'s boot log (WI-37841)', async () => {
    // The other half of WI-37841's evidence capture, and the half psu itself
    // cannot provide: a failure BEFORE node runs — psu missing from PATH, an
    // unusable login shell, a bad interpreter — exits through this shell wrapper,
    // not through psu, so only the receipt records it. Without it those failures
    // leave nothing an operator can read, which is indistinguishable from the
    // launch never having been attempted.
    //
    // Asserted by EXECUTION against the path the READER will derive, not by
    // matching a literal: a hand-written path here would keep this test green
    // while the writer and reader silently drifted apart, which is the exact
    // failure the shared derivation exists to prevent.
    const { json } = await launch({ headless: false });
    const ownerId = json.ownerId as string;
    expect(ownerId).toMatch(/^su-/);

    const expected = psuLaunchLogPath(ownerId);
    expect(expected).toBeTruthy();
    // The banner printf is tee'd to the receipt inside the keep-open wrapper.
    expect(headedInteractiveScript()).toContain(`| tee -a '${expected}'`);
  });

  it('omits the receipt on a RESUME, which pins no owner (no path to derive)', async () => {
    // A resumed session already has an identity, so the route mints no owner id —
    // and psuLaunchLogPath(null) is null. The wrapper must then degrade to its
    // pre-WI-37841 behaviour (print to the window only) rather than tee to a
    // path built from an empty string, which would collide across every resume.
    await launch({ headless: false, resume_session_id: 'sess-abc' });
    expect(headedOneliner()).not.toContain('tee -a');
  });

  it('does NOT leak an /api/mcp-suffixed PAPERCUSP_OPERATOR_URL into the spawned terminal', async () => {
    // The exact shape the desktop sidecar was observed carrying. Inherited
    // verbatim it makes psu request …/api/mcp/api/… → 404 → `not_found` → exit 1
    // in ~0.4s; since the oneliner is `exec <psu …>`, that exit closes the window
    // and the launch dies silently, leaving the adv_sessions row stuck on
    // "Starting up — waiting for this session to come online…".
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_HONO_PORT = '3170';
    await launch({ headless: false });

    expect(spawnInTerminalMock).toHaveBeenCalledTimes(1);
    const passed = headedEnv().PAPERCUSP_OPERATOR_URL;
    // The assertion that matters is the ABSENCE of the suffix — asserting only
    // the mocked value would still pass if the route stopped setting it at all.
    expect(passed).not.toMatch(/\/api\/mcp/);
    expect(passed).toBe('http://127.0.0.1:9071');
  });

  it('re-derives the base even when the operator carries NO pin of its own', async () => {
    delete process.env.PAPERCUSP_OPERATOR_URL;
    process.env.PAPERCUSP_HONO_PORT = '3170';
    await launch({ headless: false });
    // Re-derived, not merely passed through: a child left with no pin would fall
    // back to its own resolution order and could reach a DIFFERENT operator than
    // the one that just pre-minted its coord owner and adv_sessions row.
    expect(headedEnv().PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
  });

  it('leaves the rest of the operator env intact — this is a targeted override, not a scrub', async () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.WI6821_CANARY = 'keep-me';
    try {
      await launch({ headless: false });
      expect(headedEnv().WI6821_CANARY).toBe('keep-me');
    } finally {
      delete process.env.WI6821_CANARY;
    }
  });
});

/**
 * retire-mug-kettle-su-only-2026-08-09 P-042 (D-067) — the launch-time MODE.
 *
 * With the Mug/Kettle tier retired, su + its modes ARE how the app is driven, so
 * a GUI that cannot launch a session into DRAIN or AUTO leaves those postures
 * reachable only by typing them to a session that is already running.
 *
 * The whole surface under test is the MAPPING onto psu's two flag shapes, so
 * these assert on the composed argv — the same evidence the headless suite above
 * uses, for the same reason: it is what the shell actually executes.
 */
describe('launch-su — launch-time mode (P-042)', () => {
  it('passes a GOAL bootstrap subject without emitting a separate AUTO mode', async () => {
    const result = await launch({ goal_bootstrap_subject: 'goal-1', headless: true });
    expect(result.status).toBe(200);
    const cmd = headlessOneliner();
    expect(cmd).toContain('--goal-bootstrap-subject=goal-1');
    expect(cmd).not.toContain('--auto');
    expect((await launch({ goal_bootstrap_subject: 'goal-1', mode: 'auto' })).status).toBe(400);
  });
  it('mode:"drain" passes psu the NAMED-mode flag', async () => {
    await launch({ mode: 'drain', headless: false });
    expect(headedPsuCommand()).toContain('--mode=drain');
  });

  /**
   * THE LOAD-BEARING CASE. AUTO is a BOOLEAN psu flag, not a named mode:
   * `--mode=auto` would make psu forward `{mode:'auto'}` to bootstrap-su, which
   * refuses every named mode but 'drain' with a 400. A uniform `--mode=<id>`
   * mapping therefore breaks precisely the posture this feature exists to ship,
   * and it breaks it at spawn time where the terminal flashes one line and
   * closes. Assert BOTH halves — the flag present, the wrong form absent.
   */
  it('mode:"auto" passes the BOOLEAN --auto, never --mode=auto (bootstrap-su 400s on that)', async () => {
    await launch({ mode: 'auto', headless: false });
    const cmd = headedPsuCommand();
    expect(cmd).toContain('--auto');
    expect(cmd).not.toContain('--mode=auto');
  });

  it('an OMITTED mode is byte-identical to a pre-feature launch — no mode flag at all', async () => {
    await launch({ headless: false });
    const cmd = headedPsuCommand();
    expect(cmd).not.toContain('--mode=');
    expect(cmd).not.toContain('--auto');
  });

  it('carries the mode into a HEADLESS launch too (the posture is orthogonal to the window)', async () => {
    await launch({ mode: 'drain', headless: true });
    expect(headlessOneliner()).toContain('--mode=drain');
  });

  it('an unknown mode is refused with a 400 and spawns NOTHING', async () => {
    const { status, json } = await launch({ mode: 'definitely-not-a-mode', headless: false });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('mode must be one of');
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  /**
   * The falsifier that makes the guard mean something. 'goal' IS a registered
   * mode — so a validator that merely asked "is this a known mode?" would let it
   * through. It is not LAUNCHABLE: it requires a subject, and a subject-less
   * goal row silently zeroes its own consumers (work_items.goal_id, the goal
   * stop) rather than erroring. Refusing it here is the property under test.
   */
  it('refuses a mode that is REGISTERED but not launchable (goal requires a subject)', async () => {
    const { status, json } = await launch({ mode: 'goal', headless: false });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('mode must be one of');
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
  });

  it('the refusal NAMES the modes that would work, rather than only rejecting', async () => {
    const { json } = await launch({ mode: 'ideate', headless: false });
    expect(String(json.error)).toContain('drain');
    expect(String(json.error)).toContain('auto');
  });
});
