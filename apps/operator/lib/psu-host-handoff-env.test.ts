// WI-2140943 lane 2 (2026-09-02): the WI-38292 host-code handoff carried a hand-kept
// allowlist of child env keys that predated the context-trimming trio, so every headless
// fleet member that adopted updated host code re-booted with the whole ~581-tool catalog
// inline — 756k tokens on turn 1 (measured on su-d7f0f / su-038a7 / su-7b1db925 /
// su-02edb29f), respawned by the compaction watchdog every ~10 min. Two rails now:
//   1. the launcher's handoff successor re-derives the trio when absent (heal);
//   2. the pty-host allowlist is PINNED ⊇ the helper's keys, so the next key the fresh
//      path adds cannot silently fall out of the handoff again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contextTrimmingEnv,
  healContextTrimmingEnv,
  healTerminalRenderEnv,
  nativeDeferralReachable,
  terminalRenderEnv,
  applyLauncherOperatorUrlEnv,
  applyHostHandoffEnv,
  resolveOperatorTarget,
  sanitizeInheritedEnv,
  usePtyHost,
} from '../scripts/psu-launcher.mjs';
import {
  HOST_HANDOFF_ENV_KEYS,
  publishKickoffProofReceipt,
  shutdownRefusalReason,
  unreportedKickoffRefusalStrandsHost,
} from '../scripts/psu-pty-host.mjs';

describe('host adoption receipt custody (EI-25733617164988734)', () => {
  it('carries the native quota slot only through an explicit same-host adoption', () => {
    const slot = JSON.stringify({ ownerId: 'su-original', processKey: 'native:existing' });
    const before = { PAPERCUSP_SID: 'su-original', PAPERCUSP_HOSTED_NATIVE_SLOT: slot };
    const carried = Object.fromEntries(Object.entries(before).filter(([key]) => HOST_HANDOFF_ENV_KEYS.includes(key)));
    const independent = sanitizeInheritedEnv(before);
    expect(independent.PAPERCUSP_HOSTED_NATIVE_SLOT).toBeUndefined();
    applyHostHandoffEnv(independent, carried);
    expect(independent.PAPERCUSP_HOSTED_NATIVE_SLOT).toBe(slot);
  });

  it.each([false, true])('retires the original receipt even when carried by old handoff code (%s)', (carried) => {
    const receipt = {
      PAPERCUSP_KICKOFF_PROOF_PATH: '/expired-original-launch/receipt.json',
      PAPERCUSP_KICKOFF_PROOF_TOKEN: 'a'.repeat(48),
    };
    const env: Record<string, string> = { ...receipt, PAPERCUSP_SID: 'su-original' };
    applyHostHandoffEnv(env, {
      ...(carried ? receipt : {}),
      PAPERCUSP_SID: 'su-original',
      PAPERCUSP_ACCOUNT_ID: 'original-account',
      PAPERCUSP_MODEL: 'original-model',
      CODEX_HOME: '/original/isolated-home',
    });
    expect(env).toEqual({
      PAPERCUSP_SID: 'su-original',
      PAPERCUSP_ACCOUNT_ID: 'original-account',
      PAPERCUSP_MODEL: 'original-model',
      CODEX_HOME: '/original/isolated-home',
    });
    const refusal = publishKickoffProofReceipt({ persisted: false, reason: 'quota-blocked' }, env);
    expect(refusal).toEqual({ published: false, reason: 'kickoff-proof-request-missing' });
    expect(unreportedKickoffRefusalStrandsHost({ delivered: false, headless: true, receipt: refusal })).toBe(false);
  });

  it('keeps a fresh launch receipt active until an adoption actually consumes the session', () => {
    const fresh = {
      PAPERCUSP_KICKOFF_PROOF_PATH: '/expired-original-launch/receipt.json',
      PAPERCUSP_KICKOFF_PROOF_TOKEN: 'a'.repeat(48),
    };
    const refusal = publishKickoffProofReceipt({ persisted: false, reason: 'quota-blocked' }, fresh);
    expect(refusal.reason).toBe('kickoff-proof-receipt-publish-failed');
    expect(unreportedKickoffRefusalStrandsHost({ delivered: false, headless: true, receipt: refusal })).toBe(true);
  });
});

describe('host-code handoff launch provenance (EI-25370180511092356)', () => {
  const carryEnv = (env: Record<string, string>) => Object.fromEntries(
    Object.entries(env).filter(([key, value]) => HOST_HANDOFF_ENV_KEYS.includes(key) && value.length > 0),
  );

  it.each(['scoper', 'judge'])('retains the recorded %s authority across serialized adoption', (role) => {
    const successor: Record<string, string> = { PAPERCUSP_AGENT_ROLE: 'su' };
    const carried = carryEnv({ PAPERCUSP_SID: 'su-original', PAPERCUSP_AGENT_ROLE: role });
    applyHostHandoffEnv(successor, JSON.parse(JSON.stringify(carried)));
    expect(successor.PAPERCUSP_AGENT_ROLE).toBe(role);
    expect(successor.PAPERCUSP_SID).toBe('su-original');
  });

  it('retains the original launching actor for a fleetless headless successor', () => {
    const carried = carryEnv({
      PAPERCUSP_SID: 'su-original',
      PAPERCUSP_AGENT: 'codex',
      PAPERCUSP_LAUNCHED_BY: 'su-launching-agent',
      UNRELATED_SECRET: 'must-not-cross-the-handoff',
    });
    expect(carried.PAPERCUSP_LAUNCHED_BY).toBe('su-launching-agent');
    expect(carried.UNRELATED_SECRET).toBeUndefined();
    expect(shutdownRefusalReason({
      launchedBy: carried.PAPERCUSP_LAUNCHED_BY,
      headless: true,
      fleetSlug: '',
      agentQuietMs: 60_000,
    })).toBeNull();
  });

  it.each<Record<string, string>>([{}, { PAPERCUSP_LAUNCHED_BY: '' }])('does not invent agent provenance for an unmarked host (%j)', (env) => {
    const carried = carryEnv(env);
    expect(carried.PAPERCUSP_LAUNCHED_BY).toBeUndefined();
    expect(shutdownRefusalReason({
      launchedBy: carried.PAPERCUSP_LAUNCHED_BY,
      headless: true,
      fleetSlug: '',
      agentQuietMs: 60_000,
    })).toBe('not-agent-launched');
  });
});

describe('headless host-code adoption (WI-6554700010016005)', () => {
  const adopt = (before: Record<string, string>) => {
    const carried = Object.fromEntries(Object.entries(before)
      .filter(([key]) => HOST_HANDOFF_ENV_KEYS.includes(key)));
    const successor: Record<string, string> = {};
    applyHostHandoffEnv(successor, JSON.parse(JSON.stringify(carried)));
    return successor;
  };
  const detachedStdio = { stdin: { isTTY: false }, stdout: { isTTY: false } };

  it('keeps a detached carry successor on the injectable PTY path', () => {
    const before = { PAPERCUSP_PSU_HEADLESS: '1' };
    expect(usePtyHost({ env: before, ...detachedStdio })).toBe(true);

    const successor = adopt(before);

    expect(usePtyHost({ env: successor, ...detachedStdio })).toBe(true);
    expect(successor.PAPERCUSP_PSU_HEADLESS).toBe('1');
    expect(usePtyHost({ env: adopt({}), ...detachedStdio })).toBe(false);
  });

  it.each<Record<string, string>>([
    { PAPERCUSP_PSU_PTY: '0' },
    { PAPERCUSP_PSU_NO_PTY: '1' },
  ])('preserves explicit PTY refusal across a headless handoff (%j)', (policy) => {
    const before = { PAPERCUSP_PSU_HEADLESS: '1', ...policy };
    expect(usePtyHost({ env: before, ...detachedStdio })).toBe(false);

    expect(usePtyHost({ env: adopt(before), ...detachedStdio })).toBe(false);
    for (const [key, value] of Object.entries(policy)) expect(adopt(before)[key]).toBe(value);
  });

  it.each<Record<string, string>>([
    {
      PAPERCUSP_CODEX_GATEWAY: '1',
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
    },
    {
      PAPERCUSP_CODEX_GATEWAY: '1',
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin',
      PAPERCUSP_ACCOUNT_ID: 'codex-pinned-account',
    },
  ])('preserves the effective Codex provider and account route across adoption (%j)', (route) => {
    const before = { PAPERCUSP_AGENT: 'codex', ...route };
    expect(adopt(before)).toMatchObject(before);
  });
});

describe('host-code handoff turn provenance ledger (WI-6554700010025387)', () => {
  const adopt = (before: Record<string, string>) => {
    const carried = Object.fromEntries(Object.entries(before)
      .filter(([key, value]) => HOST_HANDOFF_ENV_KEYS.includes(key) && value.length > 0));
    const successor: Record<string, string> = { PAPERCUSP_HOME: '/workspace/scoped-home' };
    applyHostHandoffEnv(successor, JSON.parse(JSON.stringify(carried)));
    return successor;
  };

  it.each(['codex', 'claude'])('preserves the explicit shared ledger for a %s successor', (agent) => {
    const ledger = '/shared-control-plane/turn-provenance';
    const successor = adopt({
      PAPERCUSP_AGENT: agent,
      PAPERCUSP_TURN_PROVENANCE_DIR: ledger,
      UNRELATED_SECRET: 'must-not-cross-the-handoff',
    });

    expect(successor.PAPERCUSP_TURN_PROVENANCE_DIR).toBe(ledger);
    expect(successor.PAPERCUSP_HOME).toBe('/workspace/scoped-home');
    expect(successor.UNRELATED_SECRET).toBeUndefined();
  });

  it.each<Record<string, string>>([{}, { PAPERCUSP_TURN_PROVENANCE_DIR: '' }])(
    'leaves the default ledger selection intact when no override is supplied (%j)', (before) => {
      expect(adopt(before).PAPERCUSP_TURN_PROVENANCE_DIR).toBeUndefined();
    },
  );
});

describe('host-code handoff mutex identity', () => {
  it('preserves the explicit mutex root through adoption and launcher re-exec', () => {
    const root = '/shared-control-plane/explicit-mutex-root';
    const carried = Object.fromEntries(Object.entries({
      PAPERCUSP_SID: 'su-mutex-handoff',
      PAPERCUSP_FS_MUTEX_LOCK_DIR: root,
      UNRELATED_SECRET: 'must-not-cross-the-handoff',
    }).filter(([key]) => HOST_HANDOFF_ENV_KEYS.includes(key)));
    const successor: Record<string, string> = {};

    applyHostHandoffEnv(successor, JSON.parse(JSON.stringify(carried)));

    expect(successor.PAPERCUSP_FS_MUTEX_LOCK_DIR).toBe(root);
    expect(successor.UNRELATED_SECRET).toBeUndefined();
  });
});

describe('host-code handoff operator target provenance', () => {
  it.each(['discovery', 'env'])('retains the %s target policy through the handoff allowlist', (source) => {
    const before: Record<string, string> = {};
    applyLauncherOperatorUrlEnv(before, {
      url: 'http://127.0.0.1:24689', source, startedAt: null,
    });
    const carried = Object.fromEntries(Object.entries(before)
      .filter(([key]) => HOST_HANDOFF_ENV_KEYS.includes(key)));
    const resolved = resolveOperatorTarget({ env: carried, probe: () => false });
    expect(resolved.url).toBe(before.PAPERCUSP_OPERATOR_URL);
    expect(resolved.source).toBe(source === 'env' ? 'env' : 'managed-env');
    applyLauncherOperatorUrlEnv(carried, resolved);
    expect(carried).toEqual(before);
  });
});

// P-007: ENABLE_TOOL_SEARCH is now DERIVED from whether the ToolSearch deny leaves claude's
// native schema deferral reachable, so the claude key set is a duo while the 2026-09-11 lockout
// stands and a trio if it is ever lifted. Computing the expectation from the predicate here
// keeps these assertions honest either way: it cross-checks two independent code paths (the env
// builder against the predicate) rather than restating the env builder's own output.
// PAPERCUSP_TOOLS_COMPACT (the delivery tier for the names in PAPERCUSP_TOOLS) is emitted
// unconditionally for claude, independently of the deferral predicate, so it belongs in BOTH
// arms. It was added to contextTrimmingEnv without being added here or to the pty-host
// allowlist; the pin below caught the allowlist half, which is the half that would have hurt.
const CLAUDE_TRIMMING_KEYS = nativeDeferralReachable()
  ? ['ENABLE_TOOL_SEARCH', 'PAPERCUSP_CONTEXT_TIER', 'PAPERCUSP_TOOLS', 'PAPERCUSP_TOOLS_COMPACT']
  : ['PAPERCUSP_CONTEXT_TIER', 'PAPERCUSP_TOOLS', 'PAPERCUSP_TOOLS_COMPACT'];

describe('host-code handoff × context-trimming env (WI-2140943 lane 2)', () => {
  it('contextTrimmingEnv: claude gets the deferral-derived key set, every other agent only the payload tier', () => {
    const claude = contextTrimmingEnv('claude');
    // P-007: present IFF native deferral is actually reachable. Emitting it under the
    // ToolSearch deny turns on nothing and injects a DeferredToolPlaceholder into every request.
    expect(claude.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? 'true' : undefined,
    );
    expect(claude.PAPERCUSP_CONTEXT_TIER).toBe('trimmed');
    expect(typeof claude.PAPERCUSP_TOOLS).toBe('string');
    expect(String(claude.PAPERCUSP_TOOLS ?? '').split(',').length).toBeGreaterThan(5);
    expect(Object.keys(contextTrimmingEnv('codex'))).toEqual(['PAPERCUSP_CONTEXT_TIER']);
    expect(Object.keys(contextTrimmingEnv('omp'))).toEqual(['PAPERCUSP_CONTEXT_TIER']);
  });

  it('HOST_HANDOFF_ENV_KEYS ⊇ every key contextTrimmingEnv sets (allowlist pinned to the helper)', () => {
    const trio = Object.keys(contextTrimmingEnv('claude'));
    expect(trio.sort()).toEqual([...CLAUDE_TRIMMING_KEYS].sort());
    for (const key of trio) expect(HOST_HANDOFF_ENV_KEYS).toContain(key);
    // The allowlist must stay a SUPERSET even of the key P-007 stopped emitting: lifting the
    // ToolSearch lockout would restore ENABLE_TOOL_SEARCH, and it must not then fall out of the
    // handoff the way the original trio did (WI-2140943).
    expect(HOST_HANDOFF_ENV_KEYS).toContain('ENABLE_TOOL_SEARCH');
    // Falsifiability control: the pre-fix allowlist (the same list minus the trio) MUST fail
    // this pin — otherwise the assertion above is not measuring anything.
    const preFix = HOST_HANDOFF_ENV_KEYS.filter((k) => !trio.includes(k));
    expect(trio.some((k) => preFix.includes(k))).toBe(false);
  });

  // WI-10005917: older full-seed handoffs could carry an empty compact list, while new
  // handoffs derive the generated compact intersection. Pin both settings so the heal
  // contract is measured regardless of the runner's environment.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['off', ''],
    ['on', '1'],
  ])('healContextTrimmingEnv fills ONLY absent keys, keeps explicit values, is idempotent (full seed %s)', (_label, fullSeed) => {
    vi.stubEnv('PAPERCUSP_CLAUDE_FULL_SEED', fullSeed);
    const env: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_CONTEXT_TIER: 'full',
    };
    expect(healContextTrimmingEnv(env).sort()).toEqual(
      CLAUDE_TRIMMING_KEYS.filter((k) => k !== 'PAPERCUSP_CONTEXT_TIER').sort(),
    );
    expect(env.PAPERCUSP_CONTEXT_TIER).toBe('full');
    expect(env.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? 'true' : undefined,
    );
    expect(healContextTrimmingEnv(env)).toEqual([]);
  });

  it('a pre-fix handoff childEnv (identity keys, no trio) heals to the fresh-path env', () => {
    const env: Record<string, string | undefined> = {
      PAPERCUSP_SID: 'su-d7f0f017-4921-44e8-adb7-a663415ff93e',
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_FLEET_ROLE: 'member',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    };
    const filled = healContextTrimmingEnv(env, env.PAPERCUSP_AGENT);
    expect(filled.sort()).toEqual([...CLAUDE_TRIMMING_KEYS].sort());
    expect(env).toMatchObject(contextTrimmingEnv('claude'));
    // P-007: healing must also CONVERGE a successor that inherited the pre-fix contradiction.
    // Fill-only cannot do it — the key arrives already present from the predecessor's old code.
    const carried: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      ENABLE_TOOL_SEARCH: 'true',
    };
    healContextTrimmingEnv(carried, 'claude');
    expect(carried.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? 'true' : undefined,
    );
    // A non-claude successor gets only the tier — never a claude-only key.
    const codex: Record<string, string | undefined> = { PAPERCUSP_AGENT: 'codex' };
    expect(healContextTrimmingEnv(codex)).toEqual(['PAPERCUSP_CONTEXT_TIER']);
    expect(codex.ENABLE_TOOL_SEARCH).toBeUndefined();
  });
});

// Console-history preservation (owner terminal 2026-09-06 00:10Z): Claude Code 2.1.259's
// fullscreen TUI paints on the terminal's alternate screen, so a carry-respawn discarded two
// whole epochs of su-8ef2d from the owner's console — only their "Resume this session with"
// exit lines reached primary scrollback. The launcher now stamps
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN on every Claude spawn path, the handoff successor
// heals it, and the pty-host allowlist is pinned ⊇ the helper's keys, exactly like the trio.
describe('host-code handoff × alternate-screen env (console-history preservation)', () => {
  it('terminalRenderEnv: claude is kept off the alternate screen, other agents untouched', () => {
    expect(terminalRenderEnv('claude', {})).toEqual({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' });
    expect(terminalRenderEnv('codex', {})).toEqual({});
    expect(terminalRenderEnv('omp', {})).toEqual({});
    expect(terminalRenderEnv(undefined, {})).toEqual({});
  });

  it('an explicit value in the launch env wins (an owner who wants fullscreen sets 0)', () => {
    expect(terminalRenderEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' })).toEqual({});
    expect(terminalRenderEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' })).toEqual({});
    // An EMPTY string is not an explicit choice — the default applies.
    expect(terminalRenderEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '' })).toEqual({
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    });
  });

  it('HOST_HANDOFF_ENV_KEYS ⊇ every key terminalRenderEnv sets (allowlist pinned to the helper)', () => {
    const keys = Object.keys(terminalRenderEnv('claude', {}));
    expect(keys).toEqual(['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']);
    for (const key of keys) expect(HOST_HANDOFF_ENV_KEYS).toContain(key);
    // Falsifiability control: the pre-fix allowlist (this list minus the key) MUST fail the pin.
    const preFix = HOST_HANDOFF_ENV_KEYS.filter((k) => !keys.includes(k));
    expect(keys.some((k) => preFix.includes(k))).toBe(false);
  });

  it('healTerminalRenderEnv fills ONLY an absent key, keeps an explicit value, is idempotent', () => {
    const env: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    };
    expect(healTerminalRenderEnv(env)).toEqual(['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']);
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1');
    expect(healTerminalRenderEnv(env)).toEqual([]);
    const fullscreen: Record<string, string | undefined> = {
      PAPERCUSP_AGENT: 'claude',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0',
    };
    expect(healTerminalRenderEnv(fullscreen)).toEqual([]);
    expect(fullscreen.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('0');
    const codex: Record<string, string | undefined> = { PAPERCUSP_AGENT: 'codex' };
    expect(healTerminalRenderEnv(codex)).toEqual([]);
    expect(codex.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
  });
});
