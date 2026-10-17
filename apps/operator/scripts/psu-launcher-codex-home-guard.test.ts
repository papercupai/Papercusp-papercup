/**
 * psu-launcher-codex-home-guard.test.ts (WI-38706) — recurrence guards for the class
 * "a codex RESUME comes up against a CODEX_HOME whose config.toml no longer carries
 * the provider the rollout is bound to".
 *
 * The outage this pins (owner-hit 2026-08-14, 11 homes / 89 rollouts):
 *   1. session-archive collected the codex home's SHARED config.toml under whichever
 *      session ended first, then unlinked it — killing every sibling thread in that
 *      home. (Pinned on the archive side in session-archive.test.ts.)
 *   2. codex then re-created an 87-byte trust-only stub on the next launch. It LOOKS
 *      like a config and carries neither the gateway provider nor the coordination
 *      MCP server — so the resume either died with
 *      "Model provider `papercusp-codex-gateway` not found" (-32600) or, worse, came
 *      up quietly with NO coordination MCP at all.
 *   3. The launcher's own gateway patch made it unrecoverable: a DEFAULT-mode resume
 *      produces an empty patch, and the old code took that to mean "strip the gateway
 *      block" — deleting the provider table out from under a gateway-born thread.
 *
 * So the three functions below are the resume leg's whole defence, and each fails
 * SILENTLY (a wrong boolean, an unchanged-looking file) rather than throwing. They are
 * pinned here because none of them is exercised by a typechecker.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-codex-home-guard.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLauncher from './psu-launcher.mjs';

// PSU_LAUNCHER_MODULE_PATH lets scripts/mutation-probe.sh (copy-out mode) point this
// suite at a MUTATED copy of the launcher without dirtying the tracked file. It
// defaults to the real module; an unset variable changes nothing.
const launcherOverride = process.env.PSU_LAUNCHER_MODULE_PATH;
const launcher: typeof realLauncher = launcherOverride
  ? await import(launcherOverride)
  : realLauncher;
const {
  codexGatewayConfigPatch,
  codexRolloutModelProvider,
  codexResumeRouteNotice,
  stripCodexGatewayRoot,
  codexAuthJsonReady,
  codexFreshDefaultAuthPreflight,
  reconcileCodexSystemAuth,
  isCodexHomeLaunchReady,
  codexHomeLaunchReadiness,
  prepareCodexGatewayLaunch,
  mintCodexQuotaResumeArgs,
} = launcher;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'psu-codex-guard-'));
  // isCodexHomeLaunchReady requires a non-empty AGENTS.md ("this session's
  // behavioral spine", psu-launcher.mjs) and reads it with readFileSync, which
  // THROWS when the file is absent — the function's outer try/catch turns that
  // throw into a bare `false`. A bare mkdtemp home therefore short-circuits on
  // the FIRST check, before any of the config/owner/hooks logic below runs.
  // That broke both arms of this file, in opposite and unequally visible ways:
  // the launch-ready cases failed outright (the gate's 4 reds), while every
  // "FALSE for ..." case kept passing VACUOUSLY — returning false for the
  // missing prompt rather than for the condition it names, so it asserted
  // nothing. Materializing a real home here is what makes both arms test what
  // they claim; do not drop it to "simplify" the fixture.
  writeFileSync(join(dir, 'AGENTS.md'), '# papercusp su\n');
});

describe('selected Codex route at the actual child boundary', () => {
  it.each(['auto', 'pin'])('reapplies %s after home refresh and overrides stale provider argv', (mode) => {
    writeFileSync(join(dir, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
    const env = { PAPERCUSP_AGENT: 'codex', CODEX_HOME: dir, PAPERCUSP_SID: 'su-route',
      PAPERCUSP_ACCOUNT_ROUTING_MODE: mode, PAPERCUSP_ACCOUNT_ID: 'pool-a' };
    const id = '12345678-1234-1234-1234-123456789abc';
    const args = prepareCodexGatewayLaunch(env, ['-c', 'model_provider="openai"', '-m', 'gpt-6.1-sol',
      '-c', 'model_reasoning_effort="xhigh"', 'resume', id]);
    expect(args).toEqual(['-c', 'model_provider="papercusp-codex-gateway"', '-m', 'gpt-6.1-sol',
      '-c', 'model_reasoning_effort="xhigh"', 'resume', id]);
    const config = readFileSync(join(dir, 'config.toml'), 'utf8');
    expect(config).toContain('model_provider = "papercusp-codex-gateway"');
    expect(config).toContain('"x-papercusp-owner" = "su-route"');
    expect(config.includes('"x-papercusp-account" = "pool-a"')).toBe(mode === 'pin');
    expect(config).toContain('model_reasoning_effort = "xhigh"');
    expect(prepareCodexGatewayLaunch(env, args)).toEqual(args);
  });

  it('keeps deliberate system routing and refuses an incomplete named pin', () => {
    const args = ['-m', 'gpt-6.1-sol'];
    expect(prepareCodexGatewayLaunch({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' }, args)).toBe(args);
    expect(() => prepareCodexGatewayLaunch({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: dir,
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin' }, args)).toThrow(/selected route/);
  });

  it.each([
    ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', 'old kickoff'],
    ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', 'resume', '--last', 'old kickoff'],
    ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', 'fork', 'old-native'],
  ])('quota recovery resumes the exact conversation without replaying kickoff (%j)', (...args) => {
    const id = '12345678-1234-1234-1234-123456789abc';
    expect(mintCodexQuotaResumeArgs(args, { nativeId: id })).toEqual({ nativeId: id,
      args: ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', 'resume', id] });
    expect(mintCodexQuotaResumeArgs(args, { nativeId: null })).toBeNull();
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('codexFreshDefaultAuthPreflight — headless default launches need local auth', () => {
  it('accepts a usable ChatGPT access token without exposing its contents', () => {
    // Keep the fixture below the git-sync credential detector's entropy threshold.
    // The test only needs a non-empty token; it must never resemble a real secret.
    const NEVER_EMIT_MARKER = 'never-emit-me';
    expect(codexAuthJsonReady(JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: NEVER_EMIT_MARKER, refresh_token: NEVER_EMIT_MARKER },
    }))).toBe(true);

    const result = codexFreshDefaultAuthPreflight({
      agent: 'codex',
      headless: true,
      account: 'system',
      codexHome: dir,
      readFile: () => JSON.stringify({ tokens: { access_token: NEVER_EMIT_MARKER } }),
    });
    expect(result).toEqual({ checked: true, ready: true, reason: 'ready' });
    expect(JSON.stringify(result)).not.toContain(NEVER_EMIT_MARKER);
  });

  it.each([
    ['missing home', null, 'missing-codex-home', null],
    ['missing auth.json', 'temp-dir', 'missing-auth-json', 'throw'],
    ['malformed auth.json', 'temp-dir', 'unusable-auth-json', '{'],
    ['missing access token', 'temp-dir', 'unusable-auth-json', JSON.stringify({ tokens: {} })],
    ['blank access token', 'temp-dir', 'unusable-auth-json', JSON.stringify({ tokens: { access_token: '  ' } })],
  ])('%s fails closed with a secret-free reason', (_label, home, reason, contents) => {
    const readFile = (_path: string, _encoding: string) => {
      if (contents === 'throw') throw new Error('ENOENT');
      return contents ?? '';
    };
    const result = codexFreshDefaultAuthPreflight({
      agent: 'codex',
      headless: true,
      account: 'default',
      codexHome: home === 'temp-dir' ? dir : null,
      readFile,
    });
    expect(result).toEqual({ checked: true, ready: false, reason });
  });

  it('skips local auth checks for interactive, gateway-routed, and non-Codex launches', () => {
    const readFile = () => {
      throw new Error('must not read local auth');
    };
    for (const input of [
      { agent: 'codex', headless: false, account: 'system' },
      { agent: 'codex', headless: true, account: 'auto' },
      { agent: 'codex', headless: true, account: 'codex-pool' },
      { agent: 'claude', headless: true, account: 'system' },
    ]) {
      expect(codexFreshDefaultAuthPreflight({ ...input, codexHome: dir, readFile })).toEqual({
        checked: false,
        ready: true,
        reason: 'not-required',
      });
    }
  });
});

describe('reconcileCodexSystemAuth — one interactive login survives later PSU launches', () => {
  const auth = (lastRefresh: string, marker: string) => JSON.stringify({
    auth_mode: 'chatgpt',
    last_refresh: lastRefresh,
    tokens: {
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
      account_id: 'same-account',
    },
  });
  const sessionAuth = (name: string) =>
    join(dir, '.papercusp', 'su-codex-homes', name, 'auth.json');
  const globalAuth = () => join(dir, '.codex', 'auth.json');
  const writeSession = (name: string, raw: string) => {
    mkdirSync(join(dir, '.papercusp', 'su-codex-homes', name), { recursive: true });
    writeFileSync(sessionAuth(name), raw, { mode: 0o600 });
  };

  it('promotes only the newest complete real-file login when the canonical login is missing', () => {
    writeSession('session-old', auth('2026-09-01T01:00:00Z', 'old'));
    writeSession('session-new', auth('2026-09-01T02:00:00Z', 'new'));
    writeSession('session-partial', JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: '2026-09-01T03:00:00Z',
      tokens: { access_token: 'partial-no-refresh' },
    }));

    const result = reconcileCodexSystemAuth({ home: dir });

    expect(result).toEqual({
      promoted: true,
      reason: 'recovered-missing-system-login',
      sourceSession: 'session-new',
    });
    expect(readFileSync(globalAuth(), 'utf8')).toBe(auth('2026-09-01T02:00:00Z', 'new'));
    expect(lstatSync(globalAuth()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain('access-new');
    expect(JSON.stringify(result)).not.toContain('refresh-new');
  });

  it('promotes a newer isolated refresh but never rolls a newer canonical login backward', () => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(globalAuth(), auth('2026-09-01T02:00:00Z', 'global'), { mode: 0o600 });
    writeSession('session-newer', auth('2026-09-01T03:00:00Z', 'newer'));

    expect(reconcileCodexSystemAuth({ home: dir })).toEqual({
      promoted: true,
      reason: 'newer-isolated-login',
      sourceSession: 'session-newer',
    });
    expect(readFileSync(globalAuth(), 'utf8')).toContain('access-newer');

    writeSession('session-stale', auth('2026-09-01T01:00:00Z', 'stale'));
    expect(reconcileCodexSystemAuth({ home: dir })).toEqual({
      promoted: false,
      reason: 'canonical-current',
    });
    expect(readFileSync(globalAuth(), 'utf8')).toContain('access-newer');
  });

  it('ignores auth symlinks so the canonical file is never copied back onto itself', () => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(globalAuth(), auth('2026-09-01T02:00:00Z', 'global'), { mode: 0o600 });
    mkdirSync(join(dir, '.papercusp', 'su-codex-homes', 'session-link'), { recursive: true });
    symlinkSync(globalAuth(), sessionAuth('session-link'));

    expect(reconcileCodexSystemAuth({ home: dir })).toEqual({
      promoted: false,
      reason: 'canonical-current',
    });
  });
});

describe('launchFreshSu — preflights the exact fresh Codex home before spawning', () => {
  it('runs the default-account headless auth preflight before runWrapper', () => {
    const source = readFileSync(
      join(__dirname, '..', 'scripts', 'psu-launcher.mjs'),
      'utf8',
    );
    const body = source.slice(source.indexOf('async function launchFreshSu('));
    const reconcile = body.indexOf('reconcileCodexSystemAuth()');
    const bootstrap = body.indexOf('const res = await apiImpl("/api/agent-mcp/console/bootstrap-su"');
    const preflight = body.indexOf('codexFreshDefaultAuthPreflight({', bootstrap);
    const spawn = body.indexOf('runWrapperImpl({', preflight);

    expect(reconcile).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(bootstrap);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(bootstrap);
    expect(body.slice(preflight, spawn)).toContain('headless: args.headless');
    expect(body.slice(preflight, spawn)).toContain('account: args.account');
    expect(body.slice(preflight, spawn)).toContain('codexHome: res.codexHome');
    expect(body.slice(preflight, spawn)).toContain('process.exit(1);');
    expect(spawn).toBeGreaterThan(preflight);
  });
});

/** What psu writes into a managed home (shape only — the markers are what matter). */
const REAL_CONFIG = `# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT
model_provider = "papercusp-codex-gateway"
# END PAPERCUSP_CODEX_GATEWAY_ROOT

[tui]
terminal_title = []
alternate_screen = "never"

[mcp_servers.papercusp-su]
command = "npx"

# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER
[model_providers.papercusp-codex-gateway]
name = "Papercusp gateway"
base_url = "http://127.0.0.1:3070/api/codex-gateway"
# END PAPERCUSP_CODEX_GATEWAY_PROVIDER
`;

/** What codex itself re-creates after the config is unlinked (the 87-byte stub). */
const CODEX_STUB = `[projects."${join(homedir(), 'workspace', 'repo')}"]
trust_level = "trusted"
`;

function managedHooks(owner: string, includeLifecycle = true) {
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              command: `PAPERCUSP_LOCK_SID='${owner}' PAPERCUSP_SID='${owner}' lock.sh`,
            },
          ],
        },
      ],
      ...(includeLifecycle
        ? {
            SessionStart: [
              {
                hooks: [
                  { command: `PAPERCUSP_SID='${owner}' lifecycle-report.sh` },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  { command: `PAPERCUSP_SID='${owner}' lifecycle-report.sh` },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  { command: `PAPERCUSP_SID='${owner}' lifecycle-report.sh` },
                ],
              },
            ],
          }
        : {}),
    },
  };
}

describe('isCodexHomeLaunchReady — a codex-written stub must NOT read as a usable home', () => {
  it('true for a real papercusp home (has the coordination MCP block)', () => {
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    expect(isCodexHomeLaunchReady(dir)).toBe(true);
  });

  it('repairs a pre-0.157 home before its next GNOME Terminal resume', () => {
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG.replace('alternate_screen = "never"\n', ''));
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    expect(isCodexHomeLaunchReady(dir)).toBe(true);
  });

  it('rejects a carry-only prompt or empty carry base even when config is healthy', () => {
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    const prompt = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    writeFileSync(join(dir, 'AGENTS.md'), '\n---\n## Managed carry checkpoint\nRead the carry file.\n');
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
    writeFileSync(join(dir, 'AGENTS.md'), prompt);
    writeFileSync(join(dir, '.papercusp-carry-base-AGENTS.md'), '');
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE for the trust-only stub codex writes after the config is deleted', () => {
    writeFileSync(join(dir, 'config.toml'), CODEX_STUB);
    // The stub is a plausible-looking config.toml; existence is NOT the test.
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE when config.toml is absent entirely (the state the archiver left behind)', () => {
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE for a config that routes the gateway but never registers the MCP server', () => {
    // The dangerous middle case: the resume SUCCEEDS and the agent comes up with no
    // coordination tools — no error anywhere. The MCP block is what separates them.
    writeFileSync(
      join(dir, 'config.toml'),
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\nmodel_provider = "papercusp-codex-gateway"\n# END PAPERCUSP_CODEX_GATEWAY_ROOT\n',
    );
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE for a null/empty home rather than throwing', () => {
    expect(isCodexHomeLaunchReady(null)).toBe(false);
    expect(isCodexHomeLaunchReady('')).toBe(false);
  });

  // WI-10006770: a resume refusal used to say only "not ready", and the home
  // was gone by the time anyone looked. The reason must name the ONE check
  // that failed, so each case below breaks exactly one condition of a home
  // that is otherwise ready (calibrated first: the healthy home reads null).
  it('names the single failing check instead of a bare not-ready', () => {
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    expect(codexHomeLaunchReadiness(dir)).toBeNull();
    expect(codexHomeLaunchReadiness(null)).toBe('no Codex home recorded');

    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG.replace('alternate_screen = "never"\n', ''));
    expect(codexHomeLaunchReadiness(dir)).toMatch(/\[tui\]/);
    writeFileSync(join(dir, 'config.toml'), CODEX_STUB);
    expect(codexHomeLaunchReadiness(dir)).toBe('config.toml has no papercusp-su MCP server');
    rmSync(join(dir, 'config.toml'));
    expect(codexHomeLaunchReadiness(dir)).toBe('config.toml is missing');

    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    rmSync(join(dir, 'AGENTS.md'));
    expect(codexHomeLaunchReadiness(dir)).toBe('AGENTS.md is missing');
    writeFileSync(join(dir, 'AGENTS.md'), '   \n');
    expect(codexHomeLaunchReadiness(dir)).toBe('AGENTS.md is empty');
    // The boolean is exactly "no reason".
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE for a structurally ready home whose config/hooks/diagnostics belong to a prior owner', () => {
    const oldOwner = 'su-old-owner';
    const currentOwner = 'su-current-owner';
    writeFileSync(
      join(dir, 'config.toml'),
      `${REAL_CONFIG}\n[mcp_servers.papercusp-su]\nurl = "http://x/api/mcp?superuser=1&client=${oldOwner}"\n`,
    );
    writeFileSync(
      join(dir, 'papercusp-diagnostics.json'),
      JSON.stringify({ lockOwnerSid: oldOwner }),
    );
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(oldOwner)),
    );

    expect(isCodexHomeLaunchReady(dir, currentOwner)).toBe(false);
    expect(isCodexHomeLaunchReady(dir, oldOwner)).toBe(true);

    writeFileSync(
      join(dir, 'config.toml'),
      `${REAL_CONFIG}\n[mcp_servers.papercusp-su]\nurl = "http://x/api/mcp?superuser=1&client=${currentOwner}"\n`,
    );
    writeFileSync(
      join(dir, 'papercusp-diagnostics.json'),
      JSON.stringify({ lockOwnerSid: currentOwner }),
    );
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(currentOwner)),
    );
    expect(isCodexHomeLaunchReady(dir, currentOwner)).toBe(true);
  });

  it("FALSE for a same-owner pre-WI-41305 home that omits SessionStart/SessionEnd", () => {
    const owner = "su-lifecycle-gap";
    writeFileSync(
      join(dir, "config.toml"),
      `${REAL_CONFIG}\n[mcp_servers.papercusp-su]\nurl = "http://x/api/mcp?superuser=1&client=${owner}"\n`,
    );
    writeFileSync(
      join(dir, "papercusp-diagnostics.json"),
      JSON.stringify({ lockOwnerSid: owner }),
    );
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(owner, false)),
    );

    expect(isCodexHomeLaunchReady(dir, owner)).toBe(false);
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(owner, true)),
    );
    expect(isCodexHomeLaunchReady(dir, owner)).toBe(true);
  });

  it("FALSE for a same-owner home whose Stop event omits session-scoped lock cleanup", () => {
    const owner = "su-stop-lifecycle-gap";
    writeFileSync(
      join(dir, "config.toml"),
      `${REAL_CONFIG}\\n[mcp_servers.papercusp-su]\\nurl = "http://x/api/mcp?superuser=1&client=${owner}"\\n`,
    );
    writeFileSync(
      join(dir, "papercusp-diagnostics.json"),
      JSON.stringify({ lockOwnerSid: owner }),
    );
    const hooks = managedHooks(owner);
    delete hooks.hooks.Stop;
    writeFileSync(join(dir, "hooks.json"), JSON.stringify(hooks));

    expect(isCodexHomeLaunchReady(dir, owner)).toBe(false);
  });
});

describe('Codex resume reconciles project MCP servers', () => {
  it('calls the canonical repair route even for a structurally ready older home', async () => {
    const owner = 'su-project-mcp-resume';
    const advSessionId = Date.now() * 1_000 + (process.pid % 1_000);
    const home = join(homedir(), '.papercusp', 'su-codex-homes', `session-${advSessionId}`);
    mkdirSync(home, { recursive: true });
    const calls: Array<{ url: string; body: unknown }> = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(home, 'AGENTS.md'), '# papercusp su\n');
      writeFileSync(join(home, 'config.toml'), REAL_CONFIG.replace(
        'command = "npx"',
        `url = "http://operator/api/mcp?client=${owner}"`,
      ));
      writeFileSync(join(home, 'papercusp-diagnostics.json'), JSON.stringify({ lockOwnerSid: owner }));
      writeFileSync(join(home, 'hooks.json'), JSON.stringify(managedHooks(owner)));
      expect(isCodexHomeLaunchReady(home, owner)).toBe(true);

      const result = await launcher.ensureCodexHomeViaOperator(owner, home, advSessionId, {
        operatorUrl: 'http://operator',
        token: 'test-token',
        headless: true,
        fetchImpl: async (url: string, opts: { body: string }) => {
          calls.push({ url, body: JSON.parse(opts.body) });
          return { json: async () => ({ ok: true, repaired: true }) };
        },
      });

      expect(result).toEqual({ ok: true, repaired: true });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('repaired this session'));
      expect(calls).toEqual([{
        url: 'http://operator/api/adv/sessions/ensure-codex-home',
        body: { owner, advSessionId, requireGatewayProvider: false, headless: true },
      }]);
    } finally {
      errorSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // WI-10006770: the operator keys Codex homes by codexHomesRoot(), which honours
  // PAPERCUSP_SU_CODEX_HOMES_DIR. The launcher hard-coded ~/.papercusp/su-codex-homes,
  // so a home under an overridden root (the installed-PUI acceptance fixture) was
  // never repaired and a stub config.toml failed the readiness check on restore.
  it('repairs a home under an overridden PAPERCUSP_SU_CODEX_HOMES_DIR, and still refuses a foreign home', async () => {
    const owner = 'su-overridden-root-resume';
    const advSessionId = 7;
    const root = mkdtempSync(join(tmpdir(), 'codex-homes-root-'));
    const env = { PAPERCUSP_SU_CODEX_HOMES_DIR: root };
    const home = join(root, `session-${advSessionId}`);
    mkdirSync(home, { recursive: true });
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { json: async () => ({ ok: true, repaired: false }) };
    };
    try {
      expect(launcher.suCodexHomeForAdvSession(advSessionId, env)).toBe(home);
      expect(launcher.suCodexHomeForAdvSession(advSessionId, {}, '/h')).toBe('/h/.papercusp/su-codex-homes/session-7');

      const ours = await launcher.ensureCodexHomeViaOperator(owner, home, advSessionId, {
        operatorUrl: 'http://operator', token: 't', env, fetchImpl,
      });
      expect(ours).toEqual({ ok: true, repaired: false });
      expect(calls).toEqual(['http://operator/api/adv/sessions/ensure-codex-home']);

      // Positive control for the guard: a home that is NOT the conventional path for
      // this id (here, a different session number under the same root) is never sent.
      const foreign = await launcher.ensureCodexHomeViaOperator(owner, join(root, 'session-8'), advSessionId, {
        operatorUrl: 'http://operator', token: 't', env, fetchImpl,
      });
      expect(foreign).toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Codex managed carry keeps the selected account route', () => {
  it.each([
    ['loopback', 'http://127.0.0.1:3170', { kind: 'loopback', protocol: 'http', port: 3170 }],
    ['remote', 'https://private-user:private-password@private-host.example:4443/private-path?private-query',
      { kind: 'remote', protocol: 'https', port: 4443 }],
  ])('correlates sanitized request failure timing for %s', async (_label, operatorUrl, target) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-failure-trace-'));
    const home = join(root, 'session-7');
    let clock = 1000;
    let requestAttempt: string | null = null;
    const failures: any[] = [];
    try {
      const result = await launcher.ensureCodexHomeViaOperator('su-failure', home, 7, {
        env: { PAPERCUSP_SU_CODEX_HOMES_DIR: root }, operatorUrl,
        token: 'private-token', now: () => clock,
        onFailure: failure => { failures.push(failure); },
        fetchImpl: async (_url, init) => {
          requestAttempt = new Headers(init.headers).get('x-papercusp-repair-attempt');
          clock += 37;
          throw new TypeError('private-token private-response');
        },
      });
      expect(result).toBeNull();
      expect(requestAttempt).toMatch(/^[0-9a-f-]{36}$/);
      expect(failures).toEqual([{
        stage: 'request', reason: 'request-failed', status: null, errorName: 'TypeError',
        diagnostic: {
          attemptId: requestAttempt, startedAtMs: 1000, elapsedMs: 37, target,
          phaseTimingsMs: { 'operator-route': 0, request: 37 },
        },
      }]);
      expect(JSON.stringify(failures)).not.toMatch(/private-|https?:\/\//);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['http', 'response', 'http-error', 503],
    ['json', 'response', 'invalid-response', 200],
    ['refused', 'response', 'operator-refused', 200],
    ['throw', 'request', 'request-failed', null],
    ['pin', 'home-route', 'route-restore-failed', 200],
  ] as const)('reports sanitized %s failures while retaining the null repair contract', async (mode, stage, reason, status) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-failure-home-'));
    const env = { PAPERCUSP_SU_CODEX_HOMES_DIR: root };
    const home = join(root, 'session-7');
    const failures: unknown[] = [];
    try {
      const result = await launcher.ensureCodexHomeViaOperator('su-failure', home, 7, {
        env, operatorUrl: 'http://operator', token: 'private-token',
        routeMode: mode === 'pin' ? 'pin' : null,
        onFailure: failure => { failures.push(failure); },
        fetchImpl: async () => {
          if (mode === 'throw') throw new TypeError('request with private-token failed');
          return { status: mode === 'http' ? 503 : 200, ok: mode !== 'http', json: async () => {
            if (mode === 'json') throw new SyntaxError('private response is invalid');
            return { ok: mode !== 'refused', error: 'private-token', repaired: false };
          } };
        },
      });
      expect(result).toBeNull();
      expect(failures).toEqual([{ stage, reason, status,
        ...(mode === 'throw' ? { errorName: 'TypeError' } : mode === 'pin' ? { errorName: 'Error' } : {}),
        diagnostic: expect.objectContaining({ attemptId: expect.any(String),
          startedAtMs: expect.any(Number), elapsedMs: expect.any(Number),
          target: { kind: 'remote', protocol: 'http', port: 80 }, phaseTimingsMs: expect.any(Object) }) }]);
      expect(JSON.stringify(failures)).not.toMatch(/private-token|http:\/\/operator|private response/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a scope refusal before issuing a request, even if the observer throws', async () => {
    const failures: unknown[] = [];
    const fetchImpl = vi.fn();
    expect(await launcher.ensureCodexHomeViaOperator('su-failure', '/foreign/home', 7, {
      fetchImpl, onFailure: failure => { failures.push(failure); throw new Error('observer failed'); },
    })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failures).toEqual([{ stage: 'scope', reason: 'foreign-home', status: null,
      diagnostic: expect.objectContaining({ attemptId: expect.any(String),
        target: null, phaseTimingsMs: {} }) }]);
  });

  it.each([
    ['auto', null],
    ['pin', 'test-account'],
  ])('restores %s after the canonical home writer replaces config.toml', async (mode, id) => {
    const owner = 'su-carry-route';
    const advSessionId = Date.now() * 1_000 + (process.pid % 1_000);
    const home = join(homedir(), '.papercusp', 'su-codex-homes', `session-${advSessionId}`);
    mkdirSync(home, { recursive: true });
    const directConfig = 'model = "gpt-6-sol"\n[features]\n';
    try {
      writeFileSync(join(home, 'config.toml'), directConfig);
      const routeEnv = launcher.buildResumeEnv(
        { agent: 'codex' },
        { accountEnv: { mode, id, env: {} } },
      );
      expect(routeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe(mode);
      if (id) expect(routeEnv.PAPERCUSP_ACCOUNT_ID).toBe(id);

      await launcher.ensureCodexHomeViaOperator(owner, home, advSessionId, {
        operatorUrl: 'http://operator',
        token: 'test-token',
        routeMode: routeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE,
        accountId: routeEnv.PAPERCUSP_ACCOUNT_ID,
        priority: 'su',
        fetchImpl: async () => {
          writeFileSync(join(home, 'config.toml'), directConfig);
          return { json: async () => ({ ok: true, repaired: false }) };
        },
      });
      const config = readFileSync(join(home, 'config.toml'), 'utf8');
      expect(config).toContain('model_provider = "papercusp-codex-gateway"');
      expect(config).toContain('"x-papercusp-owner" = "su-carry-route"');
      if (id) expect(config).toContain('"x-papercusp-account" = "test-account"');
      else expect(config).not.toContain('"x-papercusp-account"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('codexGatewayConfigPatch — a default-mode RESUME must not strip a bound provider', () => {
  // An empty patch (no account pin, gateway off) means "this LAUNCH has no gateway
  // route". It does NOT mean "this HOME has no gateway thread".

  it('keepProviderTableWhenUnrouted: keeps the provider TABLE but drops the ROOT model_provider key', () => {
    // EI-22086713788860638: codex resumes with the CURRENT config's model_provider,
    // so the root key must follow the route picked THIS launch (default ⇒ no key ⇒
    // codex's built-in `openai`), while the table the rollout names must still
    // resolve (WI-38706). The pre-fix "byte-identical" behaviour left the root key
    // in place, which is how a "default" resume silently stayed on :8788 (EI-22039).
    const out = codexGatewayConfigPatch(REAL_CONFIG, null, {
      gatewayOn: false,
      keepProviderTableWhenUnrouted: true,
    });
    expect(out).not.toBe(REAL_CONFIG);
    expect(out).toContain('[model_providers.papercusp-codex-gateway]');
    expect(out).toContain('# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER');
    expect(out).not.toContain('# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT');
    expect(out).not.toMatch(/^model_provider\s*=/m);
    expect(out).toContain('[mcp_servers.papercusp-su]');
    // idempotent: patching the rootless output again changes nothing
    expect(codexGatewayConfigPatch(out, null, { gatewayOn: false, keepProviderTableWhenUnrouted: true })).toBe(out);
  });

  it('stripCodexGatewayRoot removes exactly the ROOT block and nothing else', () => {
    const out = stripCodexGatewayRoot(REAL_CONFIG);
    expect(out).not.toContain('PAPERCUSP_CODEX_GATEWAY_ROOT');
    expect(out).not.toContain('model_provider = "papercusp-codex-gateway"');
    expect(out).toContain('# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER');
    expect(out).toContain('[model_providers.papercusp-codex-gateway]');
    expect(out).toContain('[mcp_servers.papercusp-su]');
    expect(out.startsWith('\n')).toBe(false);
    expect(stripCodexGatewayRoot('')).toBe('');
  });

  it('WITHOUT the flag the provider table is stripped — the pre-fix behaviour, kept for a fresh launch', () => {
    const out = codexGatewayConfigPatch(REAL_CONFIG, null, { gatewayOn: false });
    expect(out).not.toContain('[model_providers.papercusp-codex-gateway]');
    // non-papercusp content survives either way
    expect(out).toContain('[mcp_servers.papercusp-su]');
  });

  it('a real route still rewrites the block even when keepProviderTableWhenUnrouted is set', () => {
    // The flag is a floor, not a freeze: an ACTIVE route must still be applied.
    const out = codexGatewayConfigPatch(REAL_CONFIG, null, {
      gatewayOn: true,
      ownerId: 'su-test',
      keepProviderTableWhenUnrouted: true,
    });
    expect(out).toContain('[model_providers.papercusp-codex-gateway]');
    expect(out).toContain('# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER');
    expect(out).toContain('model_provider = "papercusp-codex-gateway"');
    expect(out).toContain('[mcp_servers.papercusp-su]');
  });

  it('a direct-born config (no gateway blocks) gains ROOT + PROVIDER when the launch routes the gateway', () => {
    // The owner-hit case (EI-22086713788860638): a thread born on the system login,
    // resumed with --account=auto. The patch is what makes codex resume it on the pool.
    const direct = `[mcp_servers.papercusp-su]\ncommand = "npx"\n`;
    const out = codexGatewayConfigPatch(direct, null, { gatewayOn: true, ownerId: 'su-test', priority: 'su' });
    expect(out).toContain('model_provider = "papercusp-codex-gateway"');
    expect(out).toContain('[model_providers.papercusp-codex-gateway]');
    expect(out).toContain('"x-papercusp-owner" = "su-test"');
    expect(out).toContain('[mcp_servers.papercusp-su]');
  });

  it('keepProviderTableWhenUnrouted on an EMPTY config yields empty (nothing to preserve)', () => {
    expect(codexGatewayConfigPatch('', null, { gatewayOn: false, keepProviderTableWhenUnrouted: true })).toBe('');
  });
});

describe('codexResumeRouteNotice — a cross-family account switch is APPLIED and disclosed, never refused', () => {
  // EI-22086713788860638: the predecessor of this function (codexResumeAccountRouteError,
  // EI-22039) threw here, asserting Codex "does not permit changing model providers on
  // resume/fork". Measured false on Codex 0.152.0 in both directions (exec + TUI). The
  // notice is what survives: the owner learns the thread is moving families.
  const NEVER_REFUSE = ['cannot resume', 'cannot fork', 'NOT applied', 'no agent process was spawned'];

  it('direct-born thread + gateway route (the owner-hit case): a notice naming both sides, no refusal', () => {
    const notice = codexResumeRouteNotice('openai', { mode: 'auto' }, { sessionId: 'thread-direct' });
    expect(notice).toContain('resuming Codex thread thread-direct through the inference gateway');
    expect(notice).toContain('auto-routed');
    expect(notice).toContain("born on direct provider 'openai'");
    expect(notice).toContain('the switch is applied');
    for (const refusal of NEVER_REFUSE) expect(notice).not.toContain(refusal);
  });

  it('a pin names the account; a fork says fork', () => {
    const notice = codexResumeRouteNotice(
      'openai',
      { mode: 'pin', id: 'pool-acct-3' },
      { fork: true, sessionId: 'thread-direct' },
    );
    expect(notice).toContain('forking Codex thread thread-direct');
    expect(notice).toContain("pinned to account 'pool-acct-3'");
  });

  it('gateway-born thread + default route: a notice that the table stays so the rollout still resolves', () => {
    const notice = codexResumeRouteNotice('papercusp-codex-gateway', { mode: 'default' }, { sessionId: 'thread-gateway' });
    expect(notice).toContain('resuming Codex thread thread-gateway on the default system account');
    expect(notice).toContain("born on 'papercusp-codex-gateway'");
    expect(notice).toContain('provider table stays');
    for (const refusal of NEVER_REFUSE) expect(notice).not.toContain(refusal);
  });

  it('same-family resumes are silent', () => {
    expect(codexResumeRouteNotice('papercusp-codex-gateway', { mode: 'auto' })).toBe(null);
    expect(codexResumeRouteNotice('papercusp-codex-gateway', { mode: 'pin', id: 'x' })).toBe(null);
    expect(codexResumeRouteNotice('openai', { mode: 'default' })).toBe(null);
  });

  it('says nothing for legacy rollouts with no provider binding, or with no route', () => {
    expect(codexResumeRouteNotice(null, { mode: 'default' })).toBe(null);
    expect(codexResumeRouteNotice(null, { mode: 'auto' })).toBe(null);
    expect(codexResumeRouteNotice('openai', null)).toBe(null);
    expect(codexResumeRouteNotice('openai', { mode: 'weird' })).toBe(null);
  });
});

describe('codexRolloutModelProvider — reads the binding the resume must honour', () => {
  const rollout = (line: unknown) => {
    const p = join(dir, 'rollout.jsonl');
    writeFileSync(p, `${JSON.stringify(line)}\n{"type":"message"}\n`);
    return p;
  };

  it('returns the provider id stamped into session_meta on line 1', () => {
    const p = rollout({ type: 'session_meta', payload: { model_provider: 'papercusp-codex-gateway' } });
    expect(codexRolloutModelProvider(p)).toBe('papercusp-codex-gateway');
  });

  it('returns null for a rollout with no provider binding (a default-route thread)', () => {
    expect(codexRolloutModelProvider(rollout({ type: 'session_meta', payload: { cwd: '/x' } }))).toBe(null);
  });

  it('returns null — never throws — on an unreadable or non-JSON rollout', () => {
    expect(codexRolloutModelProvider(join(dir, 'does-not-exist.jsonl'))).toBe(null);
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'not json at all\n');
    expect(codexRolloutModelProvider(bad)).toBe(null);
    // a truncated single line with no trailing newline must not hang or throw
    const partial = join(dir, 'partial.jsonl');
    writeFileSync(partial, '{"type":"session_meta","payload":{"model_provider":"papercusp-codex-gateway"}}');
    expect(codexRolloutModelProvider(partial)).toBe('papercusp-codex-gateway');
  });

  it('reads only the FIRST line — a later line cannot re-bind the thread', () => {
    const p = join(dir, 'two.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'papercusp-codex-gateway' } })}\n` +
        `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'something-else' } })}\n`,
    );
    expect(codexRolloutModelProvider(p)).toBe('papercusp-codex-gateway');
  });
});

describe('the composed invariant: a stub home + a bound rollout is DETECTABLE and RECOVERABLE', () => {
  it('stub home reads not-ready while its rollout still names the gateway provider', () => {
    // This exact pair is what 11 homes were in. The launcher must see BOTH:
    // not-ready (⇒ rebuild the home) and a bound provider (⇒ require the gateway
    // table in the rebuild, and never strip it afterwards).
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'config.toml'), CODEX_STUB);
    const p = join(dir, 'sessions', 'rollout-2026-08-14T01-00-00-abc.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'papercusp-codex-gateway' } })}\n`,
    );

    expect(isCodexHomeLaunchReady(dir)).toBe(false);
    expect(codexRolloutModelProvider(p)).toBe('papercusp-codex-gateway');
    // and once rebuilt, a default-mode resume must not undo the rebuild — it keeps
    // the table the rollout resolves and only lets the root key follow the route
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    expect(isCodexHomeLaunchReady(dir)).toBe(true);
    const defaultResume = codexGatewayConfigPatch(REAL_CONFIG, null, {
      gatewayOn: false,
      keepProviderTableWhenUnrouted: true,
    });
    expect(defaultResume).toContain('[model_providers.papercusp-codex-gateway]');
    expect(defaultResume).not.toContain('model_provider = "papercusp-codex-gateway"');
  });
});
