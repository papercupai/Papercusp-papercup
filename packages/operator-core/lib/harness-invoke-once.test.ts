/**
 * Coverage for buildInvokeOnce — assembles the `node <tsx> <invoke-once.ts>`
 * command + env that three operator sites use to spawn a one-shot TS agent.
 * Locks in the documented, previously-bug-causing env nuances:
 *   - CLAUDE = AGENT_CMD ?? CLAUDE ?? 'omp -p'
 *   - DATABASE_URL uses `||` so an EMPTY string falls through to the admin URL
 *     (an empty value reaching the agent reads as "no PG DSN" and breaks spawn-mcp)
 *   - PAPERCUSP_USE_PG_STATE uses `??` so an explicit '0' override survives
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./harness-paths', () => ({
  tsxBin: () => '/bin/tsx-cli',
  invokeOnceBin: () => '/bin/invoke-once.ts',
}));
vi.mock('./embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => 'postgres://admin/resolved',
}));

import {
  appendForcedSessionId,
  applyBackendSwap,
  applyRoleModel,
  buildInvokeOnce,
  detectRoleBackendConflict,
  fallbackBaseCmd,
  formatRoleBackendConflict,
  inferBackendFromModelSpec,
  isOmpBackendExplicitlyConfigured,
  probeRoleRuntime,
  resolveSpawnBackendModel,
  roleBackendOverride,
  type InvokeOnceSpec,
} from './harness-invoke-once';

// WI-10006833: the merge-resolver preflight. A Server install ships no agent CLI, so the
// resolver died `spawn claude ENOENT` on every dispatch. The probe must resolve the
// command's binary on the given PATH exactly as the spawn would.
describe('WI-10006833: probeRoleRuntime', () => {
  const only = (hit: string) => (p: string) => p === hit;

  it('resolves a bare binary on the first PATH dir that has it', () => {
    const r = probeRoleRuntime('merge-resolver', {
      command: 'claude -p --model opus',
      path: '/nope:/opt/bin:/usr/bin',
      exists: only('/opt/bin/claude'),
    });
    expect(r).toEqual({ ok: true, bin: 'claude', resolved: '/opt/bin/claude' });
  });

  it('reports the binary as missing when no PATH dir has it (the c1010k joiner)', () => {
    const r = probeRoleRuntime('merge-resolver', { command: 'claude -p', path: '/usr/bin:/bin', exists: () => false });
    expect(r).toEqual({ ok: false, bin: 'claude' });
  });

  it('checks an absolute command path directly instead of searching PATH', () => {
    expect(
      probeRoleRuntime('merge-resolver', { command: '/srv/claude -p', path: '/usr/bin', exists: only('/srv/claude') }),
    ).toEqual({ ok: true, bin: '/srv/claude', resolved: '/srv/claude' });
    expect(probeRoleRuntime('merge-resolver', { command: '/srv/claude -p', exists: () => false }).ok).toBe(false);
  });

  it('an empty command is never reported runnable', () => {
    expect(probeRoleRuntime('merge-resolver', { command: '   ', exists: () => true }).ok).toBe(false);
  });
});
import { codexContextConfigArgs } from './model-context-budget.mjs';

// Fixture role is deliberately one with NO committed ROLE_MODEL_DEFAULTS entry
// (P-012 gave worker/validator/documenter/bee/scanner/judge committed tiers,
// which would append `--model <tier>` to the generic expectations below).
const spec = (over: Partial<InvokeOnceSpec> = {}): InvokeOnceSpec => ({
  projectDir: '/proj',
  stateDir: '/proj/.papercusp',
  harnessDir: '/harness-pkg',
  role: 'merge-resolver',
  extras: ['MODE=proposal', 'FEATURE_ID=F-1'],
  ...over,
});

// HERMETICITY (file-level, deliberately not per-describe). Every agent session on
// this box exports the whole AGENT_* spawn-config family — an su/psu shell carries
// AGENT_ROLE_BACKENDS + AGENT_MODELS maps that name `merge-resolver` (this file's
// fixture role, chosen ABOVE precisely for having no committed default) plus
// AGENT_BACKEND/AGENT_CMD/CLAUDE. Inherited, those silently redirect the role to a
// different backend/model and turn generic expectations red — so the suite passed or
// failed by WHO ran it, not by what the code does. Three describes had grown their
// own partial baseline for the same reason; clearing the family once, here, closes
// the class instead of one more instance of it, and every case that WANTS a value
// still stubs it (stubEnv runs after this hook).
beforeEach(() => {
  for (const key of ['AGENT_CMD', 'AGENT_MODELS', 'AGENT_ROLE_BACKENDS', 'AGENT_BACKEND', 'CLAUDE']) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => vi.unstubAllEnvs());

describe('buildInvokeOnce — command + core env', () => {
  it('resolves an absolute `node` runtime (not the bare basename) + augments the child PATH', () => {
    // A bare `spawn('node')` ENOENTs when the operator sidecar's PATH omits
    // node's dir (froze git-sync/deploys ~10h on 2026-06-20). buildInvokeOnce
    // resolves node to an absolute path (plugin-spawn-impl augmentedSpawnPath +
    // resolveBin) so the spawn never depends on the supervisor's PATH, and pins
    // that augmented PATH onto the child env. NOT process.execPath directly —
    // that can be a non-node wrapper binary in the packaged desktop.
    const { command, args, env } = buildInvokeOnce(spec());
    expect(command).toMatch(/(?:^|\/)node$/); // absolute `…/node`, or bare `node` fallback
    expect(args).toEqual(['/bin/tsx-cli', '/bin/invoke-once.ts']);
    // env.PATH is augmented with the running runtime's own bin dir.
    const nodeDir = process.execPath.replace(/[/\\][^/\\]+$/, '');
    expect(env.PATH).toContain(nodeDir);
  });

  it('threads the project/state/harness dirs, role, and JSON-encoded extras', () => {
    const { env } = buildInvokeOnce(spec());
    expect(env.PROJECT_DIR).toBe('/proj');
    expect(env.STATE_DIR).toBe('/proj/.papercusp');
    expect(env.HARNESS_DIR).toBe('/harness-pkg');
    expect(env.LOG_DIR).toBe('/proj/.papercusp/logs');
    expect(env.ROLE).toBe('merge-resolver');
    expect(env.EXTRAS_JSON).toBe(JSON.stringify(['MODE=proposal', 'FEATURE_ID=F-1']));
  });

  it('sets RESULT_PATH only when a resultPath is given', () => {
    expect(buildInvokeOnce(spec()).env.RESULT_PATH).toBeUndefined();
    expect(buildInvokeOnce(spec({ resultPath: '/tmp/r.out' })).env.RESULT_PATH).toBe('/tmp/r.out');
  });

  it('merges extraEnv and skips undefined values', () => {
    const { env } = buildInvokeOnce(spec({ extraEnv: { SCOPER_MODE: 'x', SKIP: undefined } }));
    expect(env.SCOPER_MODE).toBe('x');
    expect(env.SKIP).toBeUndefined();
  });
});

describe('appendForcedSessionId / buildInvokeOnce forceSessionId (P-016 / D-007)', () => {
  it('appends --session-id only for a claude command', () => {
    expect(appendForcedSessionId('claude -p', 'uuid-1')).toBe('claude -p --session-id uuid-1');
    expect(appendForcedSessionId('claude -p --model sonnet', 'u')).toBe('claude -p --model sonnet --session-id u');
  });

  it('leaves omp / codex commands unchanged (they resume by thread id / rollout)', () => {
    expect(appendForcedSessionId('omp -p', 'uuid-1')).toBe('omp -p');
    expect(appendForcedSessionId('codex exec', 'uuid-1')).toBe('codex exec');
  });

  it('is idempotent — never double-appends', () => {
    const once = appendForcedSessionId('claude -p', 'uuid-1');
    expect(appendForcedSessionId(once, 'uuid-2')).toBe(once);
    expect(appendForcedSessionId('claude --session-id=abc -p', 'uuid-2')).toBe('claude --session-id=abc -p');
  });

  it('buildInvokeOnce bakes --session-id into a claude AGENT_CMD when forceSessionId is set', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    const { env } = buildInvokeOnce(spec({ forceSessionId: 'uuid-xyz' }));
    expect(env.AGENT_CMD).toContain('claude');
    expect(env.AGENT_CMD).toContain('--session-id uuid-xyz');
    expect(env.CLAUDE).toBe(env.AGENT_CMD);
  });

  it('buildInvokeOnce leaves an omp AGENT_CMD un-forced even with forceSessionId', () => {
    vi.stubEnv('AGENT_CMD', 'omp -p');
    const { env } = buildInvokeOnce(spec({ forceSessionId: 'uuid-xyz' }));
    expect(env.AGENT_CMD).toContain('omp');
    expect(env.AGENT_CMD).not.toContain('--session-id');
  });

  it('buildInvokeOnce without forceSessionId never adds --session-id', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    const { env } = buildInvokeOnce(spec());
    expect(env.AGENT_CMD).not.toContain('--session-id');
  });
});

describe('buildInvokeOnce — env-resolution nuances', () => {
  beforeEach(() => {
    // Hermetic baseline — the dev box's .env.local carries a real AGENT_MODELS
    // map whose role entries would append `--model <x>` to these expectations
    // (see the RB-012 describe below for the same trap).
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // Same class of trap. The DATABASE_URL cases below assert the NON-isolated
    // resolution, but buildInvokeOnce deliberately IGNORES an inherited DATABASE_URL
    // when PAPERCUSP_PG_PORT is set (WI-1666: an isolated process must never be
    // rerouted to the box's shared native PG). Every isolated runner exports it — a
    // desktop sidecar, a smoke witness, a rig instance, scripts/with-test-pg.mjs — so
    // leaving it ambient made these cases pass only where it happened to be unset.
    // The isolated branch gets its own explicit test below.
    vi.stubEnv('PAPERCUSP_PG_PORT', undefined as unknown as string);
  });

  // These two isolate CLAUDE/AGENT_CMD resolution, so they use `reviewer` — a role
  // with NO committed ROLE_MODEL_DEFAULTS floor. spec()'s default `merge-resolver`
  // now pins opus:xhigh (D-008 follow-up), which applyRoleModel emits as
  // `--model opus[1m] --effort max` for Claude Code — the committed-floor twin
  // of the env trap the beforeEach neutralizes.
  it("CLAUDE defaults to 'omp -p' when neither AGENT_CMD nor CLAUDE is set", () => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    expect(buildInvokeOnce(spec({ role: 'reviewer' })).env.CLAUDE).toBe('omp -p');
  });

  it('CLAUDE prefers AGENT_CMD over CLAUDE', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('CLAUDE', 'should-not-win');
    expect(buildInvokeOnce(spec({ role: 'reviewer' })).env.CLAUDE).toBe('claude -p');
  });

  it('DATABASE_URL: an EMPTY string falls through to the resolved admin URL (|| not ??)', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(buildInvokeOnce(spec()).env.DATABASE_URL).toBe('postgres://admin/resolved');
  });

  it('PAPERCUSP_DATABASE_URL tracks DATABASE_URL so the worker pg-bootstrap hits the SAME DB', () => {
    // pg-bootstrap.defaultDsn reads PAPERCUSP_DATABASE_URL (NOT DATABASE_URL), then
    // ~/.papercusp/embedded-pg.json, then :5432/papercusp. If unset, a worker whose
    // operator DB ≠ that fallback (the gym) connects to the wrong DB. Mirror DATABASE_URL
    // onto PAPERCUSP_DATABASE_URL so the worker's bootstrap tracks the operator's DB.
    vi.stubEnv('PAPERCUSP_DATABASE_URL', undefined as unknown as string);
    vi.stubEnv('DATABASE_URL', 'postgres://gym/db');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_DATABASE_URL).toBe('postgres://gym/db');
  });

  it('PAPERCUSP_DATABASE_URL: an explicit value is kept (not overwritten by DATABASE_URL)', () => {
    vi.stubEnv('PAPERCUSP_DATABASE_URL', 'postgres://explicit/pg');
    vi.stubEnv('DATABASE_URL', 'postgres://other/db');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_DATABASE_URL).toBe('postgres://explicit/pg');
  });

  it('PAPERCUSP_DATABASE_URL: empty DATABASE_URL falls through to the resolved admin URL', () => {
    vi.stubEnv('PAPERCUSP_DATABASE_URL', undefined as unknown as string);
    vi.stubEnv('DATABASE_URL', '');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_DATABASE_URL).toBe('postgres://admin/resolved');
  });

  // The WI-1666 invariant itself. It had NO test: the `PAPERCUSP_PG_PORT ? '' : …`
  // branch was only ever exercised implicitly, by whether the ambient env happened to
  // carry the var. An isolated process (explicit PAPERCUSP_PG_PORT) must resolve its
  // OWN embedded PG and never let an inherited DATABASE_URL — agent shells export the
  // box's shared native :5432 — reroute the spawned worker to it.
  it('an ISOLATED process (PAPERCUSP_PG_PORT set) ignores an inherited DATABASE_URL', () => {
    vi.stubEnv('PAPERCUSP_PG_PORT', '54329');
    vi.stubEnv('PAPERCUSP_DATABASE_URL', undefined as unknown as string);
    vi.stubEnv('DATABASE_URL', 'postgres://shared-native/db');
    const { env } = buildInvokeOnce(spec());
    expect(env.DATABASE_URL, 'inherited DATABASE_URL must not win in an isolated process').toBe(
      'postgres://admin/resolved',
    );
    expect(env.PAPERCUSP_DATABASE_URL, 'the worker bootstrap must track the isolated DB too').toBe(
      'postgres://admin/resolved',
    );
  });

  it('DATABASE_URL: an explicit value is kept', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://explicit/db');
    expect(buildInvokeOnce(spec()).env.DATABASE_URL).toBe('postgres://explicit/db');
  });

  it("PAPERCUSP_USE_PG_STATE defaults to '1' but an explicit '0' override survives (??)", () => {
    vi.stubEnv('PAPERCUSP_USE_PG_STATE', undefined as unknown as string);
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_USE_PG_STATE).toBe('1');
    vi.stubEnv('PAPERCUSP_USE_PG_STATE', '0');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_USE_PG_STATE).toBe('0');
  });
});

describe('applyRoleModel — per-role model override', () => {
  it('overrides the global --model for a role with an AGENT_MODELS entry', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p --model haiku', 'worker')).toBe('claude -p --model sonnet[1m]');
  });

  it('leaves a role with NO entry on the base command (fast default)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p --model haiku', 'director')).toBe('claude -p --model haiku');
  });

  it('parses a <model>:<effort> spec → appends --model AND --effort', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'merge-resolver': 'claude-opus-4-8:xhigh' }));
    expect(applyRoleModel('claude -p --model haiku', 'merge-resolver')).toBe(
      'claude -p --model claude-opus-4-8[1m] --effort xhigh',
    );
  });

  it('maps <model>:<effort> to Codex config instead of unsupported --effort', () => {
    vi.stubEnv(
      'AGENT_MODELS',
      JSON.stringify({ kettle: 'gpt-5.5:high', blender: 'chatgpt:5.5:high', worker: 'sol:max' }),
    );
    expect(applyRoleModel('codex exec --model gpt-5.4 -c model_reasoning_effort="low"', 'kettle')).toBe(
      'codex exec --model gpt-5.5 -c model_reasoning_effort="high"',
    );
    expect(applyRoleModel('codex exec --model gpt-5.4', 'blender')).toBe(
      'codex exec --model gpt-5.5 -c model_reasoning_effort="high"',
    );
    // gpt-5.6-sol declares an extended window, so the command also carries the
    // window pair (plan codex-1m-context-window-2026-08-17 P-003). The two
    // gpt-5.5 cases above deliberately do NOT: that model's max equals its
    // default, so there is nothing bigger to ask for.
    //
    // The pair is SPREAD FROM THE CANONICAL RESOLVER rather than hardcoded, the
    // same seam psu-launcher.test.ts pins `modelArgsFor` with. Hardcoding the
    // numbers made this assertion HOST-DEPENDENT: codexContextWindowConfig reads
    // the box's own `~/.codex/models_cache.json`, whose `max_context_window` is
    // authoritative over the CODEX_EXTENDED_WINDOW_FALLBACK table (D-007). This
    // box's cache declares 872000 for gpt-5.6-sol, so the literal 1000000 — the
    // table value, which only applies when NO record exists — red the gate on
    // every machine that had ever run codex. What THIS test owns is that
    // applyRoleModel appends whatever the resolver emits, in lockstep; the
    // resolver's own numbers are covered hermetically (with a synthetic `home`)
    // in model-context-budget.test.ts.
    const windowArgs = codexContextConfigArgs('gpt-5.6-sol');
    expect(windowArgs).toHaveLength(4); // calibration: an empty pair would make the assertion vacuous
    expect(applyRoleModel('codex exec -m gpt-5.4', 'worker')).toBe(
      ['codex exec --model gpt-5.6-sol -c model_reasoning_effort="max"', ...windowArgs].join(' '),
    );
  });

  it('does not accumulate window overrides when re-applied to its own output (P-003)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sol:max' }));
    const once = applyRoleModel('codex exec -m gpt-5.4', 'worker');
    expect(applyRoleModel(once, 'worker')).toBe(once);
    expect(once.match(/model_context_window/g)).toHaveLength(1);
    // ...and a re-apply that MOVES to a non-extended model drops the stale pair
    // rather than leaving an 872k declaration on a 272k model.
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'gpt-5.5:high' }));
    expect(applyRoleModel(once, 'worker')).toBe('codex exec --model gpt-5.5 -c model_reasoning_effort="high"');
  });

  // EI-7138: omp takes `<model>[:<effort>]` as ONE opaque spec natively (no standalone
  // --effort flag) — splitting it apart (as this function used to, unconditionally,
  // regardless of backend) silently dropped the effort for an omp-backed role, the
  // exact same class of bug this function already guards against for codex/claude.
  it('omp: a `<model>:<effort>` spec passes through VERBATIM (no split — omp has no standalone --effort flag)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus:high' }));
    expect(applyRoleModel('omp -p', 'worker')).toBe('omp -p --model opus:high');
    expect(applyRoleModel('omp -p', 'worker', 'sonnet:xhigh')).toBe('omp -p --model sonnet:xhigh');
  });

  it('strips a pre-existing --effort and replaces it; keeps a colon-bearing model id when the suffix is not an effort', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus:max', reviewer: 'vendor/model:7b' }));
    // pre-existing --effort low is stripped, the role's max wins
    expect(applyRoleModel('claude -p --model haiku --effort low', 'worker')).toBe('claude -p --model opus[1m] --effort max');
    // ':7b' is not a known effort → the whole string stays as the model id (no --effort)
    expect(applyRoleModel('claude -p --model haiku', 'reviewer')).toBe('claude -p --model vendor/model:7b');
  });

  it('appends --model when the base command has none; handles --model=<x> form', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p', 'worker')).toBe('claude -p --model sonnet[1m]');
    expect(applyRoleModel('claude -p --model=haiku', 'worker')).toBe('claude -p --model sonnet[1m]');
  });

  it('no / unparseable / empty-entry AGENT_MODELS → base unchanged (fail-safe, role without a committed default)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p --model haiku', 'director')).toBe('claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', 'not json');
    expect(applyRoleModel('claude -p --model haiku', 'director')).toBe('claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ director: '', scoper: 123 }));
    expect(applyRoleModel('claude -p --model haiku', 'director')).toBe('claude -p --model haiku');
    expect(applyRoleModel('claude -p --model haiku', 'scoper')).toBe('claude -p --model haiku');
  });

  it('buildInvokeOnce overrides BOTH AGENT_CMD and CLAUDE per-role (resolveAgentCmd prefers AGENT_CMD)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    const w = buildInvokeOnce(spec({ role: 'worker' })).env;
    // Both must be the role command — only setting CLAUDE is masked by the
    // inherited AGENT_CMD (resolveAgentCmd reads AGENT_CMD ?? CLAUDE).
    expect(w.AGENT_CMD).toBe('claude -p --model sonnet[1m]');
    expect(w.CLAUDE).toBe('claude -p --model sonnet[1m]');
    const d = buildInvokeOnce(spec({ role: 'director' })).env;
    expect(d.AGENT_CMD).toBe('claude -p --model haiku');
    expect(d.CLAUDE).toBe('claude -p --model haiku');
  });
});

describe('applyRoleModel — committed ROLE_MODEL_DEFAULTS floor (EI-7)', () => {
  it('release-manager resolves its Opus 5 xhigh default to max at the Claude boundary', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model opus[1m] --effort max');
  });

  it('the committed default applies even when AGENT_MODELS is set for OTHER roles only', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p --model haiku', 'release-manager')).toBe('claude -p --model opus[1m] --effort max');
  });

  it('an explicit AGENT_MODELS entry OVERRIDES the committed default (env wins)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-manager': 'claude-opus-4-8:max' }));
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model claude-opus-4-8[1m] --effort max');
  });

  it('malformed AGENT_MODELS still yields the committed default (fail-safe to the floor, not the CLI default)', () => {
    vi.stubEnv('AGENT_MODELS', 'not json');
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model opus[1m] --effort max');
  });

  it('normalizes only Claude Code Opus 5 xhigh; other Claude families and backends keep xhigh', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'worker', 'claude-opus-5-5:xhigh')).toBe(
      'claude -p --model claude-opus-5-5[1m] --effort max',
    );
    expect(applyRoleModel('claude -p', 'worker', 'claude-opus-4-8:xhigh')).toBe(
      'claude -p --model claude-opus-4-8[1m] --effort xhigh',
    );
    expect(applyRoleModel('omp -p', 'worker', 'opus:xhigh')).toBe('omp -p --model opus:xhigh');
    expect(applyRoleModel('codex exec', 'worker', 'gpt-5.5:xhigh')).toBe(
      'codex exec --model gpt-5.5 -c model_reasoning_effort="xhigh"',
    );
  });

  it('a role with neither an entry nor a committed default is still left unchanged', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p --model haiku', 'director')).toBe('claude -p --model haiku');
  });

  it('P-012 model-tier policy: execution tier → sonnet, autonomous-loop tier → sonnet[1m]:high, without env', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'worker')).toBe('claude -p --model sonnet[1m]');
    expect(applyRoleModel('claude -p', 'validator')).toBe('claude -p --model sonnet[1m]');
    expect(applyRoleModel('claude -p', 'documenter')).toBe('claude -p --model sonnet[1m]');
    // WI-4623 revert (owner decision 2026-07-16): cup/judge sit on the
    // autonomous-loop sonnet-5 trimmed floor — the BARE `sonnet[1m]:high`, NOT the
    // P-020 gpt-5.6-luna:high — so they run on the claude CLI. No role currently
    // occupies the haiku volume tier (ROLE_MODEL_DEFAULTS comment).
    expect(applyRoleModel('claude -p --model opus', 'cup')).toBe('claude -p --model sonnet[1m] --effort high');
    expect(applyRoleModel('claude -p', 'judge')).toBe('claude -p --model sonnet[1m] --effort high');
    // `scanner` LEFT this tier on 2026-09-02 (owner directive, interactive): it is one of the
    // three roles here that also carry an operator_agent_config roleBackends entry, so it moved
    // to opus:xhigh with mug/kettle. It stays on the CLAUDE backend either way.
    expect(applyRoleModel('claude -p', 'scanner')).toBe('claude -p --model opus[1m] --effort max');
    // Escalation stays explicit: an AGENT_MODELS entry overrides the tier.
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus:high' }));
    expect(applyRoleModel('claude -p', 'worker')).toBe('claude -p --model opus[1m] --effort high');
  });

  // EI-8164: the doc-steward — a launch-fixer-family role that reads several whole source files
  // per run to re-verify a batch of drifted docs — was registered late and had NO committed
  // default, so applyRoleModel returned the base command UNCHANGED and it launched on the bare
  // CLI default (a 200k auto-compact window — no `[1m]` marker is injected when no spec resolves).
  // Its multi-file reads then thrashed autocompact → "Prompt is too long" (context_overflow),
  // repeated failed spawns. The committed `sonnet` default routes it through the [1m] normalizer
  // → the 967k window, so this regression asserts the launch command carries sonnet[1m], NOT the
  // bare `claude -p` it produced before the fix.
  // ⚠ 2026-09-02 (owner directive, interactive): doc-steward moved from `sonnet` to
  // `opus:xhigh`. The EI-8164 INVARIANT THIS TEST EXISTS FOR IS UNCHANGED and is what
  // must keep passing — the launch command must carry a `[1m]` marker, never the bare
  // `claude -p` that thrashed autocompact. `opus` is in DEFAULT_1M_FAMILY_RE just as
  // `sonnet` is, so the spec still normalizes with the marker. Only the tier moved.
  it('doc-steward resolves to opus[1m] (1M window) without env — never the bare 200k CLI default', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'doc-steward')).toBe('claude -p --model opus[1m] --effort max');
    // the committed default still applies when AGENT_MODELS is set for OTHER roles only
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p', 'doc-steward')).toBe('claude -p --model opus[1m] --effort max');
    // resolveSpawnBackendModel keys it to the opus[1m] bucket, not the empty (bare-default) one
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('doc-steward')).toMatchObject({ backend: 'claude-code', model: 'opus[1m]' });
  });

  it('resolveSpawnBackendModel keys release-manager to its committed opus bucket without env (RB-012)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('release-manager')).toMatchObject({ backend: 'claude-code', model: 'opus[1m]' });
  });

  // WI-4623 (owner decision 2026-07-16, relayed by su-d838f112): the pot's
  // judgment/control-loop layer (queen, bees, mug, kettle/overwatch, sentinel) sits
  // on the latest sonnet at 1M-window + high effort — REVERTING the P-020
  // gpt-5.6-luna:high migration (WI-4640) that hard-downed kettle. ROLE_MODEL_DEFAULTS
  // pins the spec WITH the `[1m]` marker already embedded, so normalizeModelSpec
  // (idempotent — a no-op when `[1m]` is already present) does not re-inject it.
  // ⚠ EI-12657: the spec is the BARE `sonnet[1m]`, NOT the versioned shorthand
  // `sonnet-5[1m]` — `sonnet-5` is not a resolvable alias (validateCloudModelSpec
  // rejects it), so it would reach the CLI/gateway as an unrunnable upstream id and
  // every autonomous spawn would die before its first turn. Asserted per-role at the
  // exec boundary (applyRoleModel) so a regression on any ONE role names itself.
  it('the autonomous-loop roles stay on the claude backend; mug/kettle now at opus[1m]:xhigh (WI-4623 revert + 2026-09-02 owner directive)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // `operator` is DELIBERATELY excluded — it's the interactive brain surface, not
    // an autonomous-loop role, and it has no committed default (the orchestrator's
    // own invoke.test.ts pins `resolveModel({}, 'operator')` === '').
    for (const role of ['queen', 'bee', 'overwatch', 'sentinel']) {
      expect(applyRoleModel('claude -p', role)).toBe('claude -p --model sonnet[1m] --effort high');
    }
    // ⚠ mug + kettle LEFT the sonnet tier on 2026-09-02 (owner directive, interactive):
    // they carry operator_agent_config roleBackends entries, so they moved to opus:xhigh
    // with the rest of that 8-role set. WI-4623's ACTUAL invariant — these roles resolve to
    // a CLAUDE-shaped spec and never swap the spawn to the codex CLI — is unchanged and is
    // asserted below; only the tier moved.
    for (const role of ['mug', 'kettle']) {
      expect(applyRoleModel('claude -p', role)).toBe('claude -p --model opus[1m] --effort max');
    }
    expect(applyRoleModel('claude -p', 'operator')).toBe('claude -p');
    // the committed default still applies when AGENT_MODELS is set for OTHER roles only
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p', 'mug')).toBe('claude -p --model opus[1m] --effort max');
    // resolveSpawnBackendModel keys it to the opus[1m] bucket on the CLAUDE backend:
    // an opus committed default is NOT codex-shaped, so no backend swap fires —
    // the spawn stays on the claude CLI (the whole point of the WI-4623 revert).
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('mug')).toMatchObject({ backend: 'claude-code', model: 'opus[1m]' });
  });

  // WI-4623 revert (2026-07-17): kettle's committed default returned to a claude-
  // shaped `sonnet[1m]:high`, so buildInvokeOnce keeps it on the `claude` CLI and
  // does NOT swap to codex — the standing guard against the P-020 kettle@papercusp
  // hard-down (its Codex-only gpt-5.6-luna:high default made the fallback `claude -p`
  // carry `--model gpt-5.6-luna`, which Anthropic 404'd every fire at 23:54Z/00:24Z/
  // 00:55Z/01:25Z, rc=1 in ~5s). The codex-swap MECHANISM itself (effective-spec
  // inference: per-spawn override > AGENT_MODELS > committed default) is still
  // exercised for an EXPLICIT codex spec by the two tests below.
  it('kettle\'s committed default stays on the claude backend (WI-4623 revert; hard-down guard)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const { env } = buildInvokeOnce(spec({ role: 'kettle' }));
    // 2026-09-02 (owner directive, interactive): the committed default is now `opus:xhigh`.
    // The GUARD this test exists for is the two assertions below — a claude-SHAPED default
    // must not swap the spawn to codex. opus is claude-shaped, so the guard still holds.
    expect(env.AGENT_CMD).toBe('claude -p --model opus[1m] --effort max');
    expect(env.AGENT_BACKEND).not.toBe('codex');
    expect(env.PAPERCUSP_SPAWN_BACKEND).not.toBe('codex');
  });

  it('a Codex-shaped AGENT_MODELS entry swaps the backend the same way', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'gpt-5.6:high' }));
    const { env } = buildInvokeOnce(spec({ role: 'worker' }));
    expect(env.AGENT_CMD).toBe('codex exec --model gpt-5.6 -c model_reasoning_effort="high"');
    expect(env.AGENT_BACKEND).toBe('codex');
  });

  it('a claude-alias per-spawn override on a Codex-floored role stays on claude (pin shape)', () => {
    // The mitigation shape while a codex path is broken: pin the role to a
    // claude spec. The override IS the effective spec, it is not Codex-shaped,
    // so no swap fires and the pin actually lands on the claude CLI.
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const { env } = buildInvokeOnce(
      spec({ role: 'kettle', extraEnv: { PAPERCUSP_SPAWN_MODEL: 'sonnet[1m]:high' } }),
    );
    expect(env.AGENT_CMD).toBe('claude -p --model sonnet[1m] --effort high');
  });
});

describe('applyRoleModel — per-spawn override (PAPERCUSP_SPAWN_MODEL, queen-model-tier-selection P-001)', () => {
  it('the override outranks the AGENT_MODELS entry AND the committed default', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'haiku' }));
    expect(applyRoleModel('claude -p', 'worker', 'opus:high')).toBe('claude -p --model opus[1m] --effort high');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'release-manager', 'sonnet')).toBe('claude -p --model sonnet[1m]');
  });

  it('an empty/whitespace override falls through to the normal chain', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p', 'worker', '')).toBe('claude -p --model sonnet[1m]');
    expect(applyRoleModel('claude -p', 'worker', '  ')).toBe('claude -p --model sonnet[1m]');
    expect(applyRoleModel('claude -p', 'worker', undefined)).toBe('claude -p --model sonnet[1m]');
  });

  it('buildInvokeOnce reads extraEnv.PAPERCUSP_SPAWN_MODEL into the role command', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const env = buildInvokeOnce(spec({ role: 'worker', extraEnv: { PAPERCUSP_SPAWN_MODEL: 'opus:xhigh' } })).env;
    expect(env.AGENT_CMD).toBe('claude -p --model opus[1m] --effort max');
    expect(env.CLAUDE).toBe('claude -p --model opus[1m] --effort max');
    // and the env var itself rides to the child for invoke.ts resolveModel
    expect(env.PAPERCUSP_SPAWN_MODEL).toBe('opus:xhigh');
  });

  it('a Codex-shaped per-spawn model swaps the backend before appending the model', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const env = buildInvokeOnce(spec({ role: 'kettle', extraEnv: { PAPERCUSP_SPAWN_MODEL: 'chatgpt:5.5:high' } }));
    expect(env.env.AGENT_CMD).toBe('codex exec --model gpt-5.5 -c model_reasoning_effort="high"');
    expect(env.env.CLAUDE).toBe('codex exec --model gpt-5.5 -c model_reasoning_effort="high"');
    expect(env.env.AGENT_BACKEND).toBe('codex');
    expect(env.env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
    expect(env.env.PAPERCUSP_SPAWN_MODEL).toBe('chatgpt:5.5:high');
  });

  it('resolveSpawnBackendModel keys the governor bucket to the override model', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('cup', 'opus:high')).toMatchObject({ backend: 'claude-code', model: 'opus[1m]' });
  });

  it('resolveSpawnBackendModel infers Codex for Codex-shaped per-spawn models', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(inferBackendFromModelSpec('gpt-5.5:xhigh')).toBe('codex');
    expect(inferBackendFromModelSpec('chatgpt:5.5')).toBe('codex');
    expect(resolveSpawnBackendModel('kettle', 'gpt-5.5:xhigh')).toMatchObject({ backend: 'codex', model: 'gpt-5.5' });
    expect(resolveSpawnBackendModel('kettle', 'chatgpt:5.5:xhigh')).toMatchObject({ backend: 'codex', model: 'gpt-5.5' });
  });

  it('fallbackBaseCmd picks claude for CC bare aliases, but NOT for omp-runnable claude-* ids', () => {
    // `omp models` publishes no BARE alias, so a bare spec is unambiguously
    // Claude Code's and the no-config fallback must launch `claude`…
    expect(fallbackBaseCmd('sonnet[1m]:high')).toBe('claude -p');
    expect(fallbackBaseCmd('opus:high')).toBe('claude -p');
    expect(fallbackBaseCmd('sonnet')).toBe('claude -p');
    expect(fallbackBaseCmd('haiku')).toBe('claude -p');
    // …while a FULLY-QUALIFIED claude-* id is a real omp model (claude-bridge /
    // papercusp-gateway both publish these). Steering those to the claude binary
    // would be this same bug with the sign flipped, so the regex is anchored on
    // BOTH ends. These are the CONTROLS — they must keep the omp default.
    expect(fallbackBaseCmd('claude-sonnet-4-6')).toBe('omp -p');
    expect(fallbackBaseCmd('claude-opus-4-8:high')).toBe('omp -p');
    expect(fallbackBaseCmd('claude-haiku-4-5')).toBe('omp -p');
    // …and an absent/codex spec is untouched.
    expect(fallbackBaseCmd(undefined)).toBe('omp -p');
    expect(fallbackBaseCmd('gpt-5.5:xhigh')).toBe('omp -p');
    // The FORCING inference stays codex-only: a claude alias must not outrank an
    // explicit operator backend (AGENT_CMD / AGENT_ROLE_BACKENDS), which is what
    // separates this fix from the narrower codex one.
    expect(inferBackendFromModelSpec('sonnet[1m]:high')).toBeUndefined();
    expect(inferBackendFromModelSpec('opus:high')).toBeUndefined();
  });

  it('pairs a cup with the claude binary even when the spawning process exports no AGENT_CMD', () => {
    // REGRESSION GUARD, WI-36197 (goal-mode-2026-08-07 P-002). Every other test
    // in this file stubs AGENT_CMD='claude -p', which is precisely why the suite
    // could not see the outage: papercup-bg-host.service exports it (mug/kettle
    // booted fine) but the OPERATOR process does not, and `cup:spawn` is served
    // there. With it unset the base command fell through to the `'omp -p'`
    // literal while the committed spec stayed `cup: 'sonnet[1m]:high'`, so six
    // consecutive cup:spawns returned `ok` and died in ~1.5s with
    // `Model "sonnet[1m]:high" not found. Run "omp models"`.
    //
    // The invariant is NOT "cups run on claude" — it is that the resolved MODEL
    // and the resolved BINARY always come from the same provider, at every
    // spawner, whether or not that process happens to export AGENT_CMD.
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('cup')).toMatchObject({ backend: 'claude-code', model: 'sonnet[1m]' });
    // …and the sibling autonomous-loop roles that share the committed spec.
    expect(resolveSpawnBackendModel('mug').backend).toBe('claude-code');
    expect(resolveSpawnBackendModel('kettle').backend).toBe('claude-code');

    // CONTROL — this is what makes the three assertions above falsifiable rather
    // than merely true. Setting AGENT_CMD explicitly to omp must still yield omp
    // (an operator's stated intent is preserved; see fallbackBaseCmd's doc). So
    // the SAME role resolves differently in the two configurations, and that can
    // only happen if the no-config fallback really is spec-derived. Were
    // fallbackBaseCmd to regress to the old unconditional `'omp -p'` literal,
    // both branches would collapse onto omp and this pair would fail — which is
    // exactly the live 2026-08-08 outage.
    vi.stubEnv('AGENT_CMD', 'omp -p');
    expect(resolveSpawnBackendModel('cup').backend).toBe('omp');
  });
});

describe('applyBackendSwap + per-tier backend (PAPERCUSP_SPAWN_BACKEND)', () => {
  it('swaps the base command to the target backend default only when backends differ', () => {
    expect(applyBackendSwap('claude -p --model haiku', 'omp')).toBe('omp -p');
    expect(applyBackendSwap('omp -p', 'claude-code')).toBe('claude -p');
    expect(applyBackendSwap('omp -p', 'codex')).toBe('codex exec');
    // same backend → the host's tuned command survives untouched
    expect(applyBackendSwap('claude -p --model haiku --effort low', 'claude-code')).toBe('claude -p --model haiku --effort low');
    // absent/unknown backend → no-op
    expect(applyBackendSwap('claude -p', undefined)).toBe('claude -p');
    expect(applyBackendSwap('claude -p', 'gemini')).toBe('claude -p');
  });

  it('buildInvokeOnce swaps the command, applies the model, and pins AGENT_BACKEND', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model haiku');
    vi.stubEnv('AGENT_BACKEND', 'claude-code');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const env = buildInvokeOnce(spec({
      role: 'merge-resolver',
      extraEnv: { PAPERCUSP_SPAWN_MODEL: 'anthropic/claude-opus-4-8', PAPERCUSP_SPAWN_BACKEND: 'omp' },
    })).env;
    expect(env.AGENT_CMD).toBe('omp -p --model anthropic/claude-opus-4-8');
    expect(env.CLAUDE).toBe('omp -p --model anthropic/claude-opus-4-8');
    // the child's resolveAgentBackend prefers AGENT_BACKEND — must follow the swap
    expect(env.AGENT_BACKEND).toBe('omp');
    expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('omp');
  });

  it('without a spawn backend the inherited AGENT_BACKEND is untouched', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_BACKEND', 'claude-code');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const env = buildInvokeOnce(spec({ role: 'merge-resolver' })).env;
    expect(env.AGENT_BACKEND).toBe('claude-code');
  });

  it('role backend overrides swap the command when no per-spawn backend is set', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model haiku');
    vi.stubEnv('AGENT_BACKEND', 'claude-code');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ mug: 'codex', 'release-manager': 'omp' }));

    expect(roleBackendOverride('mug')).toBe('codex');
    const env = buildInvokeOnce(spec({ role: 'mug' })).env;
    // mug resolves to its committed opus:xhigh default (2026-09-02 owner directive); this
    // test FORCES the codex backend via AGENT_ROLE_BACKENDS, so the command takes the codex
    // shape and :xhigh maps to codex's model_reasoning_effort config. The point here is
    // the backend-OVERRIDE swap, not the model choice.
    expect(env.AGENT_CMD).toBe('codex exec --model opus -c model_reasoning_effort="xhigh"');
    expect(env.CLAUDE).toBe('codex exec --model opus -c model_reasoning_effort="xhigh"');
    expect(env.AGENT_BACKEND).toBe('codex');
    expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
    // EI-7138: omp takes a `<model>:<effort>` spec as ONE opaque value natively (no
    // standalone --effort flag) — applyRoleModel no longer splits it apart for a
    // non-codex/non-claude backend, so the resolved model here is the full spec.
    expect(resolveSpawnBackendModel('release-manager')).toMatchObject({ backend: 'omp', model: 'opus:xhigh' });
  });

  it('resolveSpawnBackendModel follows the backend override for the governor bucket + session-id decision', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('cup', 'haiku', 'omp')).toMatchObject({ backend: 'omp', model: 'haiku' });
    vi.stubEnv('AGENT_CMD', 'omp -p');
    expect(resolveSpawnBackendModel('cup', 'opus:high', 'claude-code')).toMatchObject({ backend: 'claude-code', model: 'opus[1m]' });
  });
});

// EI-18133554034909305 "Agent spawns are failing repeatedly (other)": tracked
// hive/overwatch launches (spawn.ts) hard-400'd on ANY host with no explicit
// backend config, because resolveSpawnBackendModel's fallthrough default is the
// literal `'omp -p'` and omp cannot support forced-native-session-id. The fix
// rescues that unconfigured-default case (spawn.ts falls back to claude-code)
// but must still hard-fail when omp was an EXPLICIT operator choice — this is
// the discriminator that decision keys off.
describe('isOmpBackendExplicitlyConfigured (EI-18133554034909305)', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    vi.stubEnv('AGENT_ROLE_BACKENDS', undefined as unknown as string);
  });

  it('is false when nothing is configured (the bare code-level omp default)', () => {
    expect(isOmpBackendExplicitlyConfigured('mug')).toBe(false);
  });

  it('is true when AGENT_ROLE_BACKENDS explicitly pins the role to omp', () => {
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ mug: 'omp' }));
    expect(isOmpBackendExplicitlyConfigured('mug')).toBe(true);
    // a DIFFERENT role's override doesn't count for this role
    expect(isOmpBackendExplicitlyConfigured('kettle')).toBe(false);
  });

  it('is false when AGENT_ROLE_BACKENDS pins the role to a non-omp backend', () => {
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ mug: 'codex' }));
    expect(isOmpBackendExplicitlyConfigured('mug')).toBe(false);
  });

  it('is true when AGENT_CMD is explicitly configured', () => {
    vi.stubEnv('AGENT_CMD', 'omp -p --custom-flag');
    expect(isOmpBackendExplicitlyConfigured('mug')).toBe(true);
  });

  it('is true when CLAUDE is explicitly configured (AGENT_CMD unset)', () => {
    vi.stubEnv('CLAUDE', 'omp -p');
    expect(isOmpBackendExplicitlyConfigured('mug')).toBe(true);
  });
});

describe('resolveSpawnBackendModel — governor bucket key for a pipeline spawn (RB-012)', () => {
  beforeEach(() => {
    // Hermetic baseline: the dev box's .env.local carries a real AGENT_MODELS
    // map (with a `worker` entry) — without this stub, applyRoleModel overrides
    // the AGENT_CMD model these tests assert (broke the green-checkpoint run,
    // which inherits the operator host's env).
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
  });

  it("default `omp -p` → omp backend (self-pacing), no model", () => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    expect(resolveSpawnBackendModel('director')).toMatchObject({ backend: 'omp', model: '' });
  });

  it('claude command → claude-code backend + the --model id', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model claude-opus-4-8');
    expect(resolveSpawnBackendModel('director')).toMatchObject({ backend: 'claude-code', model: 'claude-opus-4-8' });
  });

  it('codex command → codex backend; -m short flag is read', () => {
    vi.stubEnv('AGENT_CMD', 'codex exec -m gpt-5.5');
    expect(resolveSpawnBackendModel('director')).toMatchObject({ backend: 'codex', model: 'gpt-5.5' });
  });

  it('per-role AGENT_MODELS override flows into the resolved model (so opus/sonnet get separate buckets)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model claude-sonnet-4-6');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ architect: 'claude-opus-4-8' }));
    expect(resolveSpawnBackendModel('architect')).toMatchObject({ backend: 'claude-code', model: 'claude-opus-4-8[1m]' });
    expect(resolveSpawnBackendModel('director')).toMatchObject({ backend: 'claude-code', model: 'claude-sonnet-4-6' });
  });

  it('--model=<x> equals form is parsed', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model=claude-haiku-4-5');
    expect(resolveSpawnBackendModel('director')).toMatchObject({ backend: 'claude-code', model: 'claude-haiku-4-5' });
  });

  it('P-012: worker buckets to its committed sonnet tier without env (no silent CLI-default bucket)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    expect(resolveSpawnBackendModel('worker')).toMatchObject({ backend: 'claude-code', model: 'sonnet[1m]' });
    // WI-4623 revert: cup's committed floor is the bare `sonnet[1m]:high`, a claude
    // id — so the bucket is the claude-code sonnet[1m] bucket, not a codex one.
    expect(resolveSpawnBackendModel('cup')).toMatchObject({ backend: 'claude-code', model: 'sonnet[1m]' });
  });
});

describe('resolved spawn effort metadata (WI-6554700010012576)', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    vi.stubEnv('AGENT_ROLE_BACKENDS', undefined as unknown as string);
  });

  it.each([
    ['codex', 'gpt-6.1-sol:xhigh', 'gpt-6.1-sol', 'xhigh'],
    ['claude-code', 'opus:xhigh', 'opus[1m]', 'max'],
    ['omp', 'claude-sonnet-4-6:high', 'claude-sonnet-4-6:high', 'high'],
  ])('records the effort actually launched by %s', (backend, requested, model, effort) => {
    expect(resolveSpawnBackendModel('director', requested, backend)).toEqual({ backend, model, effort });
  });

  it.each(['"xhigh"', "'xhigh'", 'xhigh'])('reads Codex config effort %s from the preserved command', effort => {
    vi.stubEnv('AGENT_CMD', `codex exec -m gpt-6.1-sol -c model_reasoning_effort=${effort}`);
    expect(resolveSpawnBackendModel('director')).toEqual({ backend: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  });

  it('reads Claude effort independently of the model flag', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model=claude-sonnet-4-6 --effort=high');
    expect(resolveSpawnBackendModel('director')).toEqual({ backend: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' });
  });

  it('does not invent an effort when the resolved command has none', () => {
    vi.stubEnv('AGENT_CMD', 'codex exec -m gpt-6.1-sol');
    expect(resolveSpawnBackendModel('director')).toEqual({ backend: 'codex', model: 'gpt-6.1-sol', effort: null });
  });

  it('uses the final Codex effort override from a preserved command', () => {
    vi.stubEnv('AGENT_CMD', 'codex exec --model="gpt-6.1-sol" -c model_reasoning_effort=low --config=model_reasoning_effort="xhigh"');
    expect(resolveSpawnBackendModel('director')).toEqual({ backend: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  });
});

describe('WI-2142846: role/model backend conflict is reported, not silently resolved', () => {
  it('reports the exact production conflict — a claude-code role pinned onto a codex model spec', () => {
    // The live release-fixer configuration that kept the green gate red: the role
    // backend said claude-code, the model map said a Codex-family spec, and the
    // spec won with nothing logged.
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'gpt-5.6-sol:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ 'release-fixer': 'claude-code' }));

    const conflict = detectRoleBackendConflict('release-fixer');
    expect(conflict).toEqual({
      role: 'release-fixer',
      modelSpec: 'gpt-5.6-sol:xhigh',
      inferredBackend: 'codex',
      roleBackend: 'claude-code',
    });

    // The message must name BOTH settings and which one lost, or a reader cannot
    // act on it; and it must warn off the WI-4640 "fix" of inverting precedence.
    const text = formatRoleBackendConflict(conflict!);
    expect(text).toContain('release-fixer');
    expect(text).toContain('claude-code');
    expect(text).toContain('gpt-5.6-sol:xhigh');
    expect(text).toContain('codex');
    expect(text).toContain('WI-4640');
  });

  it('does NOT change the resolved backend — the WI-4640 precedence still stands', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_BACKEND', 'claude-code');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'gpt-5.6-sol:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ 'release-fixer': 'claude-code' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = buildInvokeOnce(spec({ role: 'release-fixer' })).env;

    // Still codex: baking a Codex id onto the claude CLI 404s at launch (WI-4640).
    expect(env.AGENT_BACKEND).toBe('codex');
    expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
    // …but it is no longer silent.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[backend-conflict]');
    warn.mockRestore();
  });

  it('stays silent when there is nothing to disagree about', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // agreement — both say codex
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'gpt-5.6-sol:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ 'release-fixer': 'codex' }));
    expect(detectRoleBackendConflict('release-fixer')).toBeNull();

    // the model spec implies no backend at all, so the role backend is uncontested
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'claude-opus-5:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ 'release-fixer': 'claude-code' }));
    expect(detectRoleBackendConflict('release-fixer')).toBeNull();

    // no per-role backend set — nothing is being overridden
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'gpt-5.6-sol:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', undefined as unknown as string);
    expect(detectRoleBackendConflict('release-fixer')).toBeNull();

    // an explicit per-spawn backend outranks BOTH, so it is a choice, not a conflict
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'gpt-5.6-sol:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ 'release-fixer': 'claude-code' }));
    expect(detectRoleBackendConflict('release-fixer', undefined, 'omp')).toBeNull();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keys off the EFFECTIVE spec, so a per-spawn model override can itself create the conflict', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-fixer': 'claude-opus-5:xhigh' }));
    vi.stubEnv('AGENT_ROLE_BACKENDS', JSON.stringify({ 'release-fixer': 'claude-code' }));
    // the env map agrees with the role backend, but this spawn overrides the model
    expect(detectRoleBackendConflict('release-fixer', 'gpt-5.6-sol:xhigh')).toMatchObject({
      inferredBackend: 'codex',
      roleBackend: 'claude-code',
      modelSpec: 'gpt-5.6-sol:xhigh',
    });
  });
});
