/**
 * Unit tests for POST /api/adv/sessions/launch-su — validates the
 * psu oneliner construction + the agent/slug rejections (the
 * shell-injection-sensitive bits). spawn / fs / os are mocked so no
 * terminal is actually opened.
 *
 * spawnInTerminal (terminal-spawn.ts) does a post-spawn EARLY-EXIT probe
 * (EI-18696184925888288, WI-37743): it awaits `watchEarlyExit`, which subscribes
 * to the child's 'exit'/'error' rather than sleeping and then polling
 * `process.kill(pid, 0)`. Two consequences this file depends on:
 *   1. the `spawn` stand-in must be a real EventEmitter (see makeChild below) —
 *      a plain object has no `.on()` and fails the probe at subscribe time;
 *   2. a simulated death must EMIT an exit inside the probe window; making
 *      `process.kill` throw simulates nothing, because the probe never calls it.
 * Fake timers drive it deterministically (advanced past EARLY_EXIT_PROBE_MS in
 * `callPost`), so the assertions here see the same `status:'ok'`, no-`warning`
 * shape as before. The "silent launch failure" block flips `spawnDiesImmediately`
 * to exercise the `warning` field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';
// Resolves through the mock below, which spreads the REAL module — so this is the
// genuine constant, and asserting the route used it catches a value drift that a
// hand-copied literal in the mock would have hidden.
import { DISPLAY_TERMINAL_LAUNCH, type AdvSessionRow } from '../../adv-sessions';
// WI-6821 added `await import('../../../mcp-base-url')` to the LIVE-SPAWN branch of the
// route. Every test here runs under `vi.useFakeTimers()`, and a FIRST-TIME dynamic import
// cannot complete while fake timers are installed — the module fetch never gets the real
// timer/immediate tick it needs, so the route's promise never settles and the test sits
// until vitest's 60s cap. It only ever bit the FIRST test to take that branch (the import
// is cached for the rest), which is exactly the shape observed: `1 failed | 28 passed`,
// and a bimodal 1.4s-or-60s duration in harness_shared.test_runs.
//
// Importing it EAGERLY here puts the module in the registry before any fake clock exists,
// so the route's `await import(...)` resolves from cache. Deliberately a real import and
// NOT a `vi.mock`: `resolveSpawnHostOperatorBaseUrl` is a pure, dependency-free env reader
// (86 lines, zero imports), so the genuine implementation is both safe to load and the
// thing we actually want exercised — mocking it would assert a stub instead.
import '../../mcp-base-url';
// Same hang, second import: WI-10004158 / D-011 (commit e89081eeca, 2026-09-30) made the
// route's OMP branch with an omitted `account` do
// `await import('…/apps/operator/scripts/psu-launcher.mjs')` for `ompDefaultModel`. Only
// `agent: 'omp'` takes it, so it bit exactly 'uses --no-plan when no plan is given' (60s
// timeout, first pass AND solo). Loaded eagerly and for real, like mcp-base-url above: the
// attach-path test already loads the genuine module under this file's node:* mocks (via
// su-session-attached-launch's static import), and with `homedir()` pinned to /home/x the
// real `ompDefaultModel` deterministically returns null. A bare vi.mock factory would instead
// strip the exports su-session-attached-launch imports statically.
import '../../../../../apps/operator/scripts/psu-launcher.mjs';
import { EventEmitter } from 'node:events';
// Imported rather than hardcoded so the fake-clock advance in `callPost` cannot
// drift from the probe it has to outlast — a literal here silently under-advances
// the moment either constant is retuned, which reads as a hang, not a stale test.
// EARLY_EXIT_PROBE_MS resolves through the console-spawn mock below, which spreads
// the real module, so it is the genuine value.
import { EARLY_EXIT_PROBE_MS } from '../../console-spawn';
import { STDERR_FLUSH_GRACE_MS } from '../../terminal-spawn';

// Native GSettings is covered on a private bus in psu-gnome-renderer.test.ts.
// Keep profile preparation outside this fake-clock/process fixture, as the
// sibling terminal-spawn tests do: execFile must not touch the host desktop or
// wait on native callbacks while this suite drives the early-exit probe.
vi.mock('../../gnome-terminal-profile.mjs', () => ({
  prepareGnomeTerminal: vi.fn(async (terminal: { bin: string; args: string[] }) => terminal),
}));

/**
 * spawnInTerminal's early-exit probe is EVENT-DRIVEN (it awaits `watchEarlyExit`,
 * which subscribes to the child's 'exit'/'error'), so the child this mock returns
 * MUST be a real EventEmitter. The previous stand-in was a plain object literal
 * with no `.on()`; against the event-driven probe that throws at subscribe time,
 * the route's spawn arm reports `ok:false`, and EVERY terminal-path test in this
 * file 500s. (The headless tests kept passing throughout — they mock
 * `spawnHeadless` and never reach terminal-spawn — which is the tell that the
 * break was in this mock's SHAPE, not in the route.)
 *
 * Death is therefore simulated by EMITTING an exit inside the probe window, not
 * by making `process.kill` throw: the probe no longer consults `process.kill` at
 * all, so the old ESRCH trick silently stopped simulating anything.
 */
type FakeChild = EventEmitter & { pid?: number; unref: () => void };

/** Flipped by the "silent launch failure" tests; reset in beforeEach. */
let spawnDiesImmediately = false;

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.unref = () => {};
  if (spawnDiesImmediately) {
    // Well inside EARLY_EXIT_PROBE_MS, so the probe observes the exit rather
    // than timing out into a `likelyOpened` verdict. Driven by the fake clock
    // that `callPost` advances, so it stays deterministic.
    setTimeout(() => child.emit('exit', 1, null), 10);
  }
  return child;
}

const spawnMock = vi.fn((_bin?: string, _args?: string[], _opts?: unknown): FakeChild => makeChild());
const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...a: Parameters<typeof spawnMock>) => spawnMock(...a) };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/x' };
});

// WI-6505: the HEADLESS branch dynamically imports console-spawn/console-launcher.
// Mocked here rather than exercised for real — spawnHeadless opens a log file and
// detaches a process, neither of which belongs in a unit test — so these assert the
// route's own contract: which spawner it chose and what command it handed over.
// Safe to mock at module level: the HEADED path never touches console-spawn (it
// uses terminal-spawn), so the existing suite above is unaffected.
const { spawnHeadlessMock, buildConsoleEnvelopeMock } = vi.hoisted(() => ({
  // The return type is declared (rather than inferred from the happy-path
  // literal) so the failure test below can `mockResolvedValueOnce` an error
  // result. Inference would pin `status` to `'ok'` and reject `'error'`.
  // Deliberately a narrow structural shape, not the real `SpawnConsoleResult`:
  // that union's `ok` arm also requires `child`/`display`, which this route
  // never reads, and stubbing them here would assert a coupling that isn't real.
  spawnHeadlessMock: vi.fn(
    async (
      _opts: unknown,
    ): Promise<{
      status: 'ok' | 'error';
      pid?: number | null;
      terminal?: string;
      error?: string;
      code?: number;
    }> => ({
      status: 'ok',
      pid: 5150,
      terminal: 'headless (log: /tmp/x.log)',
    }),
  ),
  buildConsoleEnvelopeMock: vi.fn(async (_opts: unknown) => ({ cwd: '/repo', env: {}, greetingCmd: '' })),
}));
vi.mock('../../console-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../console-spawn')>()),
  spawnHeadless: spawnHeadlessMock,
}));
vi.mock('../../console-launcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../console-launcher')>()),
  buildConsoleEnvelope: buildConsoleEnvelopeMock,
}));

// Deferred-launch (D-006) records via recordAdvSession instead of spawning — mock
// it (vi.hoisted so the factory can reference the spy) so the defer_spawn path
// doesn't need a real PG.
const { getAdvSessionMock, recordAdvSessionMock } = vi.hoisted(() => ({
  getAdvSessionMock: vi.fn(async (_id: number): Promise<unknown | null> => null),
  recordAdvSessionMock: vi.fn(async (_opts: unknown) => 99),
}));
// Spread the REAL module rather than listing exports by hand: launch-su.ts also
// reads the plain-value export DISPLAY_TERMINAL_LAUNCH, and a hand-listed factory
// silently omits any export it does not name — the omission only surfaces when the
// route actually READS it, as an unhandled rejection at call time rather than a
// load-time error (EI-18818702968703959: red 3x/6h). Spreading means a new export
// added to adv-sessions can never leave this mock stale, and the constant's VALUE
// can never drift from the real one. Safe here — adv-sessions has no module-load
// side effects (only declarations), and 4 sibling suites already mock it this way.
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  getAdvSession: getAdvSessionMock,
  recordAdvSession: recordAdvSessionMock,
}));

const { nativeSessionHandleMock } = vi.hoisted(() => ({
  nativeSessionHandleMock: vi.fn((_row: unknown): unknown => null),
}));
vi.mock('../../native-session-handles', () => ({
  nativeSessionHandleForAdvSession: nativeSessionHandleMock,
}));

// A deferred (workbench) record fires a `roster` sync-invalidation so the pui
// dock-driver refetches /api/adv/roster and panes the launch immediately — mock
// sync-sse (it opens a real PG LISTEN connection otherwise) to spy on the emit.
const { notifySyncInvalidateMock } = vi.hoisted(() => ({
  notifySyncInvalidateMock: vi.fn(async (_name: string) => {}),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: notifySyncInvalidateMock,
}));

// The agent-less branch resolves the CONFIGURED backend (owner ask
// 2026-06-07) via a dynamic import of agent-config — mock it so the test
// pins the config instead of reading the dev box's real file/PG.
const { effectiveBackendMock } = vi.hoisted(() => ({
  effectiveBackendMock: vi.fn(() => 'claude-code'),
}));
vi.mock('../../agent-config', () => ({
  readAgentConfig: vi.fn(async () => ({})),
  effectiveBackend: effectiveBackendMock,
}));

// P-012 safety floor (unify-agent-spawn-chokepoint): mocked so unit tests don't
// lazy-import fleet/operator-spawn (which drags the DBOS workflow graph + PG).
// Default = headroom available; the floor tests flip it to a refusal.
const { floorMock } = vi.hoisted(() => ({
  floorMock: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
}));
vi.mock('../../interactive-safety-floor', () => ({
  checkInteractiveSafetyFloor: floorMock,
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

async function callPost(body: unknown, stream = false): Promise<Response> {
  const mod = await import('../routes/adv/launch-su');
  const route = (mod.default as Array<{ handler: (req: Request, ctx: RouteContext) => Promise<Response> }>)[0];
  const req = new Request(`http://localhost:3070/api/adv/sessions/launch-su${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resPromise = route.handler(req, CTX);
  // Flush spawnInTerminal's post-spawn early-exit probe if this call took the
  // live-spawn path — a no-op for paths that never spawn (validation rejections,
  // defer_spawn). Must outlast the probe itself PLUS the stderr flush that runs
  // only on the not-opened branch, or the route's promise never settles and the
  // test sits until vitest's 60s cap.
  await vi.advanceTimersByTimeAsync(EARLY_EXIT_PROBE_MS + STDERR_FLUSH_GRACE_MS + 100);
  return resPromise;
}

/**
 * Is this spawn call the memoized systemd-scope SUPPORT PROBE, not a real launch?
 *
 * `probeScopeSupport` (task-manager/managed-spawn.ts) runs
 * `systemd-run --user --scope --quiet --collect -- true` ONCE PER PROCESS to decide
 * whether transient cgroup scopes can be created, and it goes through this same
 * `node:child_process.spawn` seam. Because the result is memoized at module scope,
 * WHICH test observes the probe depends entirely on suite ORDER: run this file alone
 * and some earlier-imported module has usually already resolved the probe, so nothing
 * is recorded; run it inside the full suite (or any multi-file batch) and the probe can
 * land in the middle of THIS file, becoming a phantom extra `spawn` call.
 *
 * That is a pure order-dependency, not a product regression — it red-pinned the release
 * gate on 2026-08-02 while every isolated run stayed green, which is the most expensive
 * shape of flake to diagnose. Filtering the probe out here makes every assertion below
 * order-independent, and does it once for the file instead of at ~12 call sites.
 *
 * Deliberately NARROW: it matches only `systemd-run … -- true` (a payload of literally
 * `true`), so a genuine terminal launch that happens to be wrapped in systemd-run is
 * still counted. Widening this to "ignore all systemd-run calls" would silently blind
 * the file's real "no terminal was opened" assertions.
 */
function isScopeSupportProbe(call: readonly unknown[]): boolean {
  const [cmd, args] = call as [string, string[]];
  return cmd === 'systemd-run' && Array.isArray(args) && args.slice(-2).join(' ') === '-- true';
}

/** Every REAL spawn (terminal launches etc.), with infrastructure probes filtered out. */
function realSpawns(): Array<[string, string[]]> {
  return spawnMock.mock.calls.filter((c) => !isScopeSupportProbe(c)) as unknown as Array<[string, string[]]>;
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const args = realSpawns()[0][1];
  return args[args.length - 1];
}

function trackedSession(overrides: Partial<AdvSessionRow> = {}): AdvSessionRow {
  return {
    id: 99,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercup',
    planSlug: 'my-plan',
    agent: 'claude',
    role: null,
    feature: null,
    mode: 'console',
    terminalBin: null,
    pid: null,
    windowId: null,
    ompThreadId: null,
    label: null,
    cwd: '/repo',
    coordOwnerId: 'su-stable-owner',
    sessionId: 'claude-native-99',
    display: 'workbench',
    launchArgv: ['psu', '--no-picker', '--agent=claude'],
    launchedAt: '2026-08-27T23:00:00.000Z',
    startedAt: '2026-08-27T22:59:59.000Z',
    endedAt: null,
    exitCode: null,
    endedBy: null,
    endedSignal: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getAdvSessionMock.mockResolvedValue(null);
  nativeSessionHandleMock.mockReturnValue(null);
  // Default: the spawned child survives the early-exit probe, i.e. the "normal"
  // success path — no `warning` on the response. Individual tests in the
  // "silent launch failure" block flip this.
  spawnDiesImmediately = false;
  killSpy.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launch-su', () => {
  it('streams launch progress before slow preflight and preserves the final refusal', async () => {
    let release: (() => void) | undefined;
    floorMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, reason: 'fixture admission refusal' });
        }),
    );
    // The response must open while the preflight remains unresolved. Consuming
    // its body starts that asynchronous work and carries the final result.
    const opened = await callPost(
      { agent: 'codex', harness_slug: 'papercup', attached_engine: true, agent_chat_id: 'streamed-chat' },
      true,
    );
    expect(opened.headers.get('content-type')).toContain('text/event-stream');
    const wirePromise = opened.text();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    const wire = await wirePromise;
    expect(wire).toContain('event: launch-starting');
    expect(wire).toContain('event: launch-result');
    expect(wire).toContain('"httpStatus":429');
    expect(wire).toContain('fixture admission refusal');
    expect(realSpawns()).toHaveLength(0);
  });

  it('streams validation errors as terminal launch results', async () => {
    const response = await callPost({ agent: 'unsupported' }, true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const wire = await response.text();
    expect(wire).toContain('event: launch-result');
    expect(wire).toContain('"httpStatus":400');
    expect(wire).toContain('agent must be one of');
    expect(realSpawns()).toHaveLength(0);
  });

  it('spawns psu --no-picker for a valid agent + harness + plan', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(realSpawns()).toHaveLength(1);
    const oneliner = lastOneliner();
    expect(oneliner).toContain('--no-picker');
    expect(oneliner).toContain('--agent=claude');
    expect(oneliner).toContain('--harness=papercup');
    expect(oneliner).toContain('--plan=my-plan');
  });

  // WI-6363. The owner ask ("clicking +new session should open the gui chat
  // with them") was unimplementable because THIS route told the caller nothing
  // it could key a chat off: the terminal path records no adv_sessions row (psu
  // self-registers one asynchronously), so the response carried only
  // {status, agent, terminal, pid}. It now PRE-PINS the coord owner id via
  // `psu --owner-id=` and returns it. Both halves are asserted because either
  // one alone is silently useless: an id returned but not passed to psu binds
  // the chat to an owner the session never runs as (the exact split-identity
  // failure WI-5002 added the flag for), and an id passed but not returned
  // leaves the caller with nothing again.
  it('pre-pins a coord owner id, passes it to psu, and returns it (terminal path)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.status).toBe('ok');
    // Must satisfy bootstrap-su's validator, else it 400s the boot.
    expect(json.ownerId).toMatch(/^su-[A-Za-z0-9][A-Za-z0-9._-]{5,118}$/);
    expect(lastOneliner()).toContain(`--owner-id=${json.ownerId}`);
  });

  it('pre-pins the owner id on the deferred path too, so the pui-run session binds to it', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', defer_spawn: true });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.ownerId).toMatch(/^su-[A-Za-z0-9][A-Za-z0-9._-]{5,118}$/);
    // No terminal spawns here — the args are persisted as launch_argv instead,
    // so assert the recorded argv (not the oneliner) carries the pin.
    const recorded = recordAdvSessionMock.mock.calls.at(-1)?.[0] as { launchArgv?: string[] };
    expect(recorded?.launchArgv).toContain(`--owner-id=${json.ownerId}`);
  });

  // A RESUME must keep the identity it already has. Pinning a fresh owner onto
  // it would either be refused by bootstrap-su (id bound to a live row) or split
  // the resumed session from its own history.
  it('does NOT pre-pin an owner id when resuming an existing session', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      resume_session_id: 'abcd1234-5678-90ab-cdef-1234567890ab',
    });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.ownerId).toBeUndefined();
    expect(lastOneliner()).not.toContain('--owner-id=');
    expect(lastOneliner()).toContain('--resume-session=');
  });

  it('mints a DIFFERENT owner id per launch (a reused id is refused as already-bound)', async () => {
    const a = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    vi.clearAllMocks();
    killSpy.mockReturnValue(true);
    const b = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(a.ownerId).not.toBe(b.ownerId);
  });

  it('uses --no-plan when no plan is given', async () => {
    await callPost({ agent: 'omp', harness_slug: 'papercup' });
    expect(lastOneliner()).toContain('--no-plan');
    expect(lastOneliner()).toContain('--agent=omp');
  });

  it('defer_spawn records a pending workbench launch (no spawn) and returns advSessionId', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      defer_spawn: true,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.deferred).toBe(true);
    expect(json.advSessionId).toBe(99);
    // No terminal spawned — the pui pane is the single launcher (D-001).
    expect(realSpawns()).toHaveLength(0);
    // The recorded row is a pane-worthy workbench launch carrying the psu argv.
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
    const opts = recordAdvSessionMock.mock.calls[0][0] as {
      display?: string;
      launchArgv?: string[];
      agent?: string;
    };
    expect(opts.display).toBe('workbench');
    expect(opts.agent).toBe('claude');
    // P-002: this owner binding lets bootstrap adopt row 99 after PUI claims it;
    // without it psu inserts a second runtime row and the returned id goes stale.
    expect((opts as { coordOwnerId?: string }).coordOwnerId).toBe(json.ownerId);
    expect(opts.launchArgv).toEqual(
      expect.arrayContaining(['--no-picker', '--agent=claude', '--harness=papercup', '--plan=my-plan']),
    );
    // …and it wakes the pui dock-driver with a roster invalidation so the pane
    // opens deterministically (not on the firehose / 60s safety-net).
    expect(notifySyncInvalidateMock).toHaveBeenCalledWith('roster');
  });

  it('threads carry into the one deferred psu argv and rejects invalid carry', async () => {
    const ok = await callPost({
      agent: 'codex',
      harness_slug: 'papercup',
      defer_spawn: true,
      carry: 'cold',
    });
    expect(ok.status).toBe(200);
    const recorded = recordAdvSessionMock.mock.calls[0]![0] as { launchArgv?: string[] };
    expect(recorded.launchArgv).toContain('--carry=cold');
    expect(realSpawns()).toHaveLength(0);

    vi.clearAllMocks();
    const bad = await callPost({ agent: 'codex', defer_spawn: true, carry: 'lukewarm' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('carry must be warm|cold');
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
  });

  it('threads the shared model/effort/account/mode choices into the deferred psu argv', async () => {
    const res = await callPost({
      agent: 'codex',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      model: 'gpt-5.6-sol:low',
      effort: 'xhigh',
      account: 'auto',
      fleet: 'fed-drill',
      seat: 'sonnet:high:auto',
      mode: 'auto',
      defer_spawn: true,
    });
    expect(res.status).toBe(200);
    const recorded = recordAdvSessionMock.mock.calls[0]![0] as { launchArgv?: string[] };
    expect(recorded.launchArgv).toEqual(
      expect.arrayContaining([
        '--plan=my-plan',
        '--model=gpt-5.6-sol:xhigh',
        '--account=auto',
        '--fleet=fed-drill',
        '--seat=sonnet:high:auto',
        '--auto',
      ]),
    );
  });

  it('round-trips a canonical [1m] full model id through the deferred launch boundary', async () => {
    const model = 'claude-fable-5-1[1m]';
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', model, defer_spawn: true });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
    const recorded = recordAdvSessionMock.mock.calls[0]![0] as { launchArgv?: string[] };
    expect(recorded.launchArgv).toContain(`--model=${model}`);
  });

  it('rejects non-canonical bracket markers instead of widening the model grammar', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      model: 'claude-fable-5-1[200k]',
      defer_spawn: true,
    });

    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
  });

  it('refuses a delegated seat without its fleet before recording or spawning', async () => {
    const res = await callPost({
      agent: 'codex',
      seat: 'sonnet:high:auto',
      defer_spawn: true,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('seat requires fleet');
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
  });

  it('fails loudly when effort has no model instead of silently dropping it', async () => {
    const res = await callPost({ agent: 'claude', effort: 'high', defer_spawn: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('needs a model');
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
  });

  it('attaches by stable advSessionId and native handle without spawning or recording', async () => {
    const row = trackedSession({ agent: 'codex', sessionId: null });
    const native = {
      backend: 'codex',
      source: 'adv_sessions',
      ownerId: row.coordOwnerId,
      codexHome: '/tmp/codex/session-99',
      rolloutId: 'rollout-99',
      exactResumeSupported: true,
      missingReason: null,
    };
    getAdvSessionMock.mockResolvedValue(row);
    nativeSessionHandleMock.mockReturnValue(native);

    const res = await callPost({
      agent: 'codex',
      attach_adv_session_id: 99,
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      attached: true,
      advSessionId: 99,
      ownerId: 'su-stable-owner',
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercup',
      planSlug: 'my-plan',
      nativeSession: native,
    });
    expect(getAdvSessionMock).toHaveBeenCalledWith(99);
    expect(nativeSessionHandleMock).toHaveBeenCalledWith(row);
    expect(floorMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses attach backend/context mismatches and ambiguous create+attach requests', async () => {
    getAdvSessionMock.mockResolvedValue(trackedSession());

    const backend = await callPost({ agent: 'omp', attach_adv_session_id: 99 });
    expect(backend.status).toBe(409);
    expect((await backend.json()).error).toContain('backend is claude, not omp');

    const harness = await callPost({
      agent: 'claude',
      attach_adv_session_id: 99,
      harness_slug: 'other-harness',
    });
    expect(harness.status).toBe(409);

    const implicit = await callPost({ attach_adv_session_id: 99 });
    expect(implicit.status).toBe(400);
    expect((await implicit.json()).error).toContain('explicit agent');

    const ambiguous = await callPost({ agent: 'claude', attach_adv_session_id: 99, defer_spawn: true });
    expect(ambiguous.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
  });

  it('the live (non-deferred) spawn path records a `terminal` row AND wakes the roster', async () => {
    // WI-6376 (owner ask 2026-07-25): the terminal path used to write no row at
    // all, so between the click and psu's own registration the session appeared
    // in NO column. It now records the launch immediately, keyed to the pre-pinned
    // coord owner, and pushes it to open boards — the boot window is short and a
    // card that appears late is the same defect in miniature.
    //
    // This assertion previously read `not.toHaveBeenCalled()` (the pre-WI-6376
    // behaviour) and kept PASSING after the behaviour changed, because the suite's
    // adv-sessions mock omitted DISPLAY_TERMINAL_LAUNCH: the route threw while
    // building the record and never reached the invalidation below. It was a
    // vacuous guard, not a green one (EI-18818702968703959).
    await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(realSpawns()).toHaveLength(1);
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
    // display MUST be 'terminal', never 'workbench' — 'workbench' is D-006's pui
    // pane queue, and a terminal launch already has its own terminal.
    const opts = recordAdvSessionMock.mock.calls[0]![0] as { display?: string; mode?: string };
    expect(opts.display).toBe(DISPLAY_TERMINAL_LAUNCH);
    expect(opts.display).toBe('terminal');
    expect(notifySyncInvalidateMock).toHaveBeenCalledWith('roster');
  });

  it('agent-less launch resolves the CONFIGURED backend (claude-code → claude)', async () => {
    const res = await callPost({ harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.agent).toBe('claude');
    expect(effectiveBackendMock).toHaveBeenCalled();
    expect(lastOneliner()).toContain('--agent=claude');
  });

  it('agent-less launch passes a configured omp/codex straight through', async () => {
    effectiveBackendMock.mockReturnValueOnce('codex');
    const res = await callPost({ harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.agent).toBe('codex');
    expect(lastOneliner()).toContain('--agent=codex');
  });

  it('rejects an unknown agent (no spawn)', async () => {
    const res = await callPost({ agent: 'gemini', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(realSpawns()).toHaveLength(0);
  });

  it('rejects an unsafe harness slug (no spawn)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'a; rm -rf /' });
    expect(res.status).toBe(400);
    expect(realSpawns()).toHaveLength(0);
  });

  it('rejects an unsafe plan slug (no spawn)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: '$(whoami)' });
    expect(res.status).toBe(400);
    expect(realSpawns()).toHaveLength(0);
  });

  // Public launch context is trimmed-only; the retired spelling is a decoder alias.
  it('threads a valid context_size=trimmed into the psu oneliner', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: 'papercup', context_size: 'trimmed' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
    expect(lastOneliner()).toContain('--context-size=trimmed');
  });

  it('normalizes legacy context_size=full before spawn and signals the deprecation', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', context_size: 'full' });
    expect(lastOneliner()).toContain('--context-size=trimmed');
    expect(lastOneliner()).not.toContain('--context-size=full');
    expect(await res.json()).toMatchObject({
      contextSizeNormalization: { requested: 'full', effective: 'trimmed', deprecated: true },
    });
  });

  it('signals the same normalization on a deferred launch and persists only trimmed argv', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      context_size: 'full',
      defer_spawn: true,
    });
    expect(await res.json()).toMatchObject({
      status: 'ok',
      deferred: true,
      contextSizeNormalization: { requested: 'full', effective: 'trimmed', deprecated: true },
    });
    const recorded = recordAdvSessionMock.mock.calls.at(-1)?.[0] as { launchArgv?: string[] };
    expect(recorded.launchArgv).toContain('--context-size=trimmed');
    expect(recorded.launchArgv).not.toContain('--context-size=full');
  });

  it('uses the canonical trimmed context when context_size is absent or empty', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(lastOneliner()).toContain('--context-size=trimmed');
    spawnMock.mockClear();
    await callPost({ agent: 'claude', harness_slug: 'papercup', context_size: '' });
    expect(lastOneliner()).toContain('--context-size=trimmed');
  });

  it('rejects a context_size typo with 400 (no spawn)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', context_size: 'trimed' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toContain('context_size');
    expect(realSpawns()).toHaveLength(0);
  });

  // P-012 (unify-agent-spawn-chokepoint): the psu web launch passes the SAME
  // interactive safety floor as the native console launch — admission waived,
  // ceiling enforced.
  it('passes the safety floor before spawning (floor consulted, launch proceeds)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    expect(floorMock).toHaveBeenCalledTimes(1);
    expect(realSpawns()).toHaveLength(1);
  });

  it('REFUSES with 429 when the floor reports no headroom (no spawn, no defer)', async () => {
    floorMock.mockResolvedValueOnce({ ok: false, reason: 'interactive launch refused by the safety floor: 16 ≥ 16' });
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toContain('safety floor');
    expect(realSpawns()).toHaveLength(0);
  });

  it('floor also gates the deferred (workbench) path — no row recorded over-ceiling', async () => {
    floorMock.mockResolvedValueOnce({ ok: false, reason: 'interactive launch refused by the safety floor' });
    const res = await callPost({ agent: 'claude', defer_spawn: true });
    expect(res.status).toBe(429);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(realSpawns()).toHaveLength(0);
    // No row recorded → nothing to pane → no roster wake.
    expect(notifySyncInvalidateMock).not.toHaveBeenCalled();
  });

  // EI-18696184925888288: launch-su reported {status:'ok', terminal, pid} even
  // when the spawned terminal never actually materialized (a headless/offscreen
  // display) — the OS spawn call not throwing is not proof a window opened.
  describe('silent launch failure (spawned process exits almost immediately)', () => {
    it('still returns status:ok (the syscall genuinely succeeded) but adds a warning', async () => {
      spawnDiesImmediately = true;
      const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.terminal).toBe('gnome-terminal');
      expect(json.pid).toBe(4242);
      expect(typeof json.warning).toBe('string');
      expect(json.warning).toMatch(/exited almost immediately/);
    });

    it('the happy path (pid stays alive) carries no warning field', async () => {
      const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.warning).toBeUndefined();
    });

    it('the deferred (workbench) path never spawns, so it is unaffected (no warning possible)', async () => {
      spawnDiesImmediately = true;
      const res = await callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        plan_slug: 'my-plan',
        defer_spawn: true,
      });
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.deferred).toBe(true);
      expect(json.warning).toBeUndefined();
      expect(realSpawns()).toHaveLength(0);
    });
  });

  /**
   * WI-6505 — the GUI fleet-launch row needs two things this route could not do:
   * open a member with NO window, and tell the caller which fleet slug it landed
   * on so members 2..N can JOIN rather than each creating their own.
   */
  describe('headless launches (WI-6505)', () => {
    it('a headless launch passes --headless to psu and opens NO terminal', async () => {
      const res = await callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        plan_slug: 'my-plan',
        headless: true,
      });
      const json = await res.json();
      expect(json.status).toBe('ok');
      // Routed through spawnHeadless, so the terminal spawner is never reached —
      // this is what makes it windowless rather than merely claiming to be.
      expect(realSpawns()).toHaveLength(0);
      expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
      const { envelope } = spawnHeadlessMock.mock.calls[0][0] as { envelope: { greetingCmd: string } };
      expect(envelope.greetingCmd).toContain('--headless');
      expect(envelope.greetingCmd).toContain('--no-picker');
    });

    it('a HEADED launch is unchanged — no --headless flag, real terminal spawn', async () => {
      await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
      expect(lastOneliner()).not.toContain('--headless');
    });

    it('omitting `headless` is a headed launch (the flag is opt-in, never inferred)', async () => {
      await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan', headless: false });
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
      expect(lastOneliner()).not.toContain('--headless');
    });

    it('a failed headless spawn is reported as an error, not a phantom success', async () => {
      spawnHeadlessMock.mockResolvedValueOnce({ status: 'error', error: 'boom', code: 1 });
      const res = await callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        plan_slug: 'my-plan',
        headless: true,
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('boom');
    });

    /**
     * The slug is what makes a multi-member GUI launch ONE fleet. Without it the
     * client would have to re-implement the server's slugifier (which truncates
     * at 60 chars and defaults to "fleet"), and any disagreement silently splits
     * the fleet into N one-member fleets.
     */
    it('returns the resolved fleetSlug when the launch JOINS an existing fleet', async () => {
      const res = await callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        plan_slug: 'my-plan',
        fleet: 'existing-fleet',
      });
      expect((await res.json()).fleetSlug).toBe('existing-fleet');
    });

    it('omits fleetSlug entirely for an unfleeted launch', async () => {
      const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
      expect((await res.json()).fleetSlug).toBeUndefined();
    });
  });
});
