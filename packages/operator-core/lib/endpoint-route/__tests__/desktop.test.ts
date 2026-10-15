/**
 * Verification for the ported `desktop` family. Covers the pure
 * spawn-spec builders (absorbed from the old setup-pty-commands
 * route.test.ts) and the route ports mounted on a throwaway Hono app.
 *
 * `requirePrincipal` is mocked to resolve a loopback principal so the
 * `auth: {}` routes pass the route-stack gate deterministically — this
 * is the first family test where the gate actually runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'loopback', slug: 'loopback', workspaceId: 'ws',
    authMethod: 'loopback', trust: 'unverified-loopback',
    capabilities: new Set(['*']), label: 'loopback',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../agent-auth-detect', () => ({
  claudeSignedIn: vi.fn(() => true),
  codexSignedIn: vi.fn(() => false),
  ompSignedIn: vi.fn(() => false),
  ompAuthStatus: vi.fn(() => ({ present: true, provider: 'anthropic', authType: 'oauth', expiresAt: 123, accessExpired: true, hasRefresh: true })),
  githubSignedIn: vi.fn(() => false),
  anyAgentSignedIn: vi.fn(() => true),
}));
vi.mock('../../telemetry-flush', () => ({ flushTelemetry: vi.fn(async () => ({ flushed: 3 })) }));
vi.mock('../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => null),
  writeOperatorState: vi.fn(async () => {}),
  updateOperatorState: vi.fn(async (_key: string, initial: unknown, update: (current: unknown) => unknown) => update(initial)),
}));
vi.mock('../../voice-credentials', () => ({ readElevenLabsKey: vi.fn(async () => null) }));
vi.mock('../../setup-wizard-install-id', () => ({ ensureInstallId: vi.fn(async () => 'install-1') }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import desktopAgentAuthStatus from '../routes/desktop/agent-auth-status';
import desktopAgentLoginEnvelope from '../routes/desktop/agent-login-envelope';
import desktopGitIdentity from '../routes/desktop/git-identity';
import desktopPreflight from '../routes/desktop/preflight';
import desktopSetupPtyCommands, {
  buildInstallSpec,
  buildFrameworkInstallSpec,
  buildLoginSpec,
  buildGithubLoginSpec,
  ompReleaseAsset,
  ompDownloadUrl,
} from '../routes/desktop/setup-pty-commands';
import desktopSetupWizardState from '../routes/desktop/setup-wizard-state';
import desktopTelemetryFlush from '../routes/desktop/telemetry-flush';
import desktopTelemetryReport from '../routes/desktop/telemetry-report';
import desktopWorkspaceValidate from '../routes/desktop/workspace-validate';
import { writeOperatorState, readOperatorState, updateOperatorState } from '../../operator-state-pg';
import * as fallbackObservations from '../../degradation/fallback-observations';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const json = (b: unknown) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('buildInstallSpec', () => {
  it('unix: spawns bash -c with a single script arg', () => {
    const spec = buildInstallSpec('linux', '/home/u');
    expect(spec.command).toBe('bash');
    expect(spec.args[0]).toBe('-c');
    expect(spec.args).toHaveLength(2);
    expect(spec.cwd).toBe('/home/u');
  });

  it('macOS uses the same bash path as linux', () => {
    expect(buildInstallSpec('darwin', '/Users/u').command).toBe('bash');
  });

  it('windows: spawns powershell.exe with -Command', () => {
    const spec = buildInstallSpec('win32', 'C:\\Users\\u');
    expect(spec.command).toBe('powershell.exe');
    expect(spec.args).toContain('-Command');
    expect(spec.args).toContain('-NoProfile');
  });

  it('install script installs claude + codex, never meridian (decommissioned) or the dead omp npm ref', () => {
    const unix = buildInstallSpec('linux', '/home/u').args[1];
    expect(unix).toContain('claude.ai/install.sh');
    expect(unix).toContain('@openai/codex');
    // meridian is decommissioned (owner directive 2026-07-06) — never installed.
    expect(unix).not.toContain('@rynfar/meridian');
    // oh-my-pi has no live npm package (unpublished 2026-05-21); a dead
    // ref 404s and aborts the entire npm step, killing the codex install.
    expect(unix).not.toContain('oh-my-pi');
    expect(buildInstallSpec('win32', 'C:\\Users\\u').args.join(' ')).not.toContain('oh-my-pi');
  });

  it('env is empty (inherits the parent process env)', () => {
    expect(buildInstallSpec('linux', '/home/u').env).toEqual({});
  });
});

describe('ompReleaseAsset / ompDownloadUrl', () => {
  it('maps each OS+arch to the upstream release asset', () => {
    expect(ompReleaseAsset('darwin', 'arm64')).toBe('omp-darwin-arm64');
    expect(ompReleaseAsset('darwin', 'x64')).toBe('omp-darwin-x64');
    expect(ompReleaseAsset('linux', 'arm64')).toBe('omp-linux-arm64');
    expect(ompReleaseAsset('linux', 'x64')).toBe('omp-linux-x64');
    // upstream ships x64 only on Windows
    expect(ompReleaseAsset('win32', 'arm64')).toBe('omp-windows-x64.exe');
    expect(ompReleaseAsset('freebsd', 'x64')).toBeNull();
  });
  it('builds a can1357/oh-my-pi releases download URL', () => {
    const url = ompDownloadUrl('linux', 'x64');
    expect(url).toContain('https://github.com/can1357/oh-my-pi/releases/download/');
    expect(url).toContain('/omp-linux-x64');
    expect(ompDownloadUrl('freebsd', 'x64')).toBeNull();
  });
});

describe('buildFrameworkInstallSpec (per-framework onboarding installs)', () => {
  it('omp unix: downloads the release binary into ~/.local/bin + chmod +x (no npm, no brew)', () => {
    const script = buildFrameworkInstallSpec('omp', 'linux', '/home/u', 'x64').args[1];
    expect(script).toContain('github.com/can1357/oh-my-pi/releases/download');
    expect(script).toContain('omp-linux-x64');
    expect(script).toContain('~/.local/bin/omp');
    expect(script).toContain('chmod +x');
    expect(script).not.toContain('@oh-my-pi/cli'); // never the dead npm ref
    expect(script).not.toContain('npm install');
  });
  it('omp macOS arm64: picks the darwin-arm64 asset', () => {
    const script = buildFrameworkInstallSpec('omp', 'darwin', '/Users/u', 'arm64').args[1];
    expect(script).toContain('omp-darwin-arm64');
  });
  it('omp windows: powershell downloads to %USERPROFILE%\\.papercusp\\bin + persists PATH', () => {
    const spec = buildFrameworkInstallSpec('omp', 'win32', 'C:\\Users\\u', 'x64');
    expect(spec.command).toBe('powershell.exe');
    const script = spec.args[spec.args.indexOf('-Command') + 1];
    const progressGuard = "$ProgressPreference = 'SilentlyContinue'";
    expect(script).toContain('omp-windows-x64.exe');
    expect(script).toContain('.papercusp\\bin');
    expect(script).toContain("SetEnvironmentVariable('Path'");
    expect(script).toContain(progressGuard);
    expect(script.indexOf(progressGuard)).toBeLessThan(script.indexOf('Invoke-WebRequest'));
  });
  it('claude / codex per-framework specs are unchanged (claude installer / codex npm)', () => {
    expect(buildFrameworkInstallSpec('claude', 'linux', '/home/u').args[1]).toContain(
      'claude.ai/install.sh',
    );
    expect(buildFrameworkInstallSpec('codex', 'linux', '/home/u').args[1]).toContain('@openai/codex');
  });
});

describe('buildLoginSpec', () => {
  // buildLoginSpec resolves the binary to an ABSOLUTE path (the Tauri PTY child
  // has no inherited PATH, so a bare `claude` would resolve wrong). Pass the
  // path explicitly to assert the resolved-binary branch deterministically.
  it('claude: spawns `<resolved binary> /login`', () => {
    const spec = buildLoginSpec('claude', '/home/u', '/opt/bin/claude');
    expect(spec.command).toBe('/opt/bin/claude');
    expect(spec.args).toEqual(['/login']);
    expect(spec.cwd).toBe('/home/u');
  });

  it('omp: spawns `<resolved binary> /login`', () => {
    const spec = buildLoginSpec('omp', '/home/u', '/opt/bin/omp');
    expect(spec.command).toBe('/opt/bin/omp');
    expect(spec.args).toEqual(['/login']);
  });

  it('codex: spawns `<resolved binary> login`', () => {
    const spec = buildLoginSpec('codex', '/home/u', '/opt/bin/codex');
    expect(spec.command).toBe('/opt/bin/codex');
    expect(spec.args).toEqual(['login']);
    expect(spec.cwd).toBe('/home/u');
  });
});

describe('buildGithubLoginSpec', () => {
  it('chains `gh auth login` (https+web, never SSH) with `gh auth setup-git`', () => {
    const spec = buildGithubLoginSpec('/home/u');
    expect(spec.cwd).toBe('/home/u');
    expect(spec.env).toEqual({});
    // Always `bash -lc` so the two steps chain in one pty. Forces HTTPS + web/device
    // flow (never the SSH-key-upload path that errors "key is already in use"), THEN
    // wires git's credential helper to gh so the private dogfood clone authenticates
    // (without setup-git the login succeeds but the clone fails auth_required).
    expect(spec.command).toBe('bash');
    expect(spec.args[0]).toBe('-lc');
    const script = spec.args[1];
    expect(script).toMatch(/auth login --hostname github\.com --git-protocol https --web/);
    expect(script).toContain('&&');
    expect(script).toMatch(/auth setup-git --hostname github\.com/);
  });

  // WI-3626 recurrence guard: `gh auth setup-git` bakes WHICHEVER path this
  // function resolves verbatim into `credential.https://github.com.helper` in
  // ~/.gitconfig. An app-bundle-relative path (`${process.cwd()}/bin/gh`) dangles
  // the instant the app is renamed/replaced (confirmed live on the Mac VM:
  // `Papercusp.app` -> `Papercusp Server.app` / `Papercusp GUI.app`). The fix
  // (ensureGhLinked keeping a STABLE `~/.papercusp/bin/gh` shim, preferred first)
  // landed with ZERO test coverage of the actual priority order — the one test
  // above never mocks fs, so it silently exercises whichever branch happens to
  // match the real filesystem instead of proving the stable shim wins. These two
  // lock the ordering in so a future refactor can't silently re-widen the window.
  describe('gh path resolution (WI-3626)', () => {
    const appBundleCwd = '/Applications/Papercusp.app/Contents/Resources/sidecar';

    it('prefers the stable ~/.papercusp/bin/gh shim over any app-bundle-relative path', () => {
      const home = '/home/u';
      const stableShim = `${home}/.papercusp/bin/gh`;

      const spec = buildGithubLoginSpec(home, {
        cwd: appBundleCwd,
        exists: (p) => p === stableShim,
      });
      const script = spec.args[1] as string;

      expect(script).toContain(`"${stableShim}" auth login`);
      expect(script).toContain(`"${stableShim}" auth setup-git`);
      // The whole point: never bakes a path that lives inside a *.app bundle
      // when the durable shim is available.
      expect(script).not.toMatch(/\.app\//);
    });

    it('falls back to the app-bundle-relative path only when the stable shim is absent (dev box / pre-relink)', () => {
      const home = '/home/u';
      const bundleGh = `${appBundleCwd}/bin/gh`;

      const spec = buildGithubLoginSpec(home, {
        cwd: appBundleCwd,
        exists: (p) => p === bundleGh,
      });
      const script = spec.args[1] as string;

      expect(script).toContain(`"${bundleGh}" auth login`);
    });

    it('falls back to bare `gh` when nothing resolves (relies on inherited PATH, never crashes)', () => {
      const spec = buildGithubLoginSpec('/home/u', { cwd: appBundleCwd, exists: () => false });
      const script = spec.args[1] as string;
      // `which gh` also runs in this branch on a real box, which may or may not find
      // something in *this* environment — assert only the documented no-crash contract.
      expect(typeof script).toBe('string');
      expect(script).toMatch(/auth login --hostname github\.com/);
    });
  });
});

describe('desktop route ports', () => {
  it('GET /desktop/agent-auth-status returns per-provider status', async () => {
    const res = await appWith(desktopAgentAuthStatus as AnyRoute).request('/desktop/agent-auth-status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claude: true, codex: false, omp: false,
      ompAuth: { present: true, provider: 'anthropic', authType: 'oauth', expiresAt: 123, accessExpired: true, hasRefresh: true },
      github: false,
    });
  });

  it('POST /desktop/agent-login-envelope rejects an unknown provider', async () => {
    const res = await appWith(desktopAgentLoginEnvelope as AnyRoute)
      .request('/desktop/agent-login-envelope', json({ provider: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('POST /desktop/agent-login-envelope builds an envelope for a known provider', async () => {
    const res = await appWith(desktopAgentLoginEnvelope as AnyRoute)
      .request('/desktop/agent-login-envelope', json({ provider: 'claude' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ greetingCmd: 'claude /login' });
  });

  it('POST /desktop/agent-login-envelope builds a Codex repair command', async () => {
    const res = await appWith(desktopAgentLoginEnvelope as AnyRoute)
      .request('/desktop/agent-login-envelope', json({ provider: 'codex' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ greetingCmd: 'codex login' });
  });

  it('GET /desktop/git-identity returns a source field', async () => {
    const res = await appWith(desktopGitIdentity as AnyRoute[]).request('/desktop/git-identity');
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).source).toBe('string');
  });

  it('POST /desktop/git-identity rejects a missing name (400)', async () => {
    const res = await appWith(desktopGitIdentity as AnyRoute[])
      .request('/desktop/git-identity', json({ email: 'a@b.com' }));
    expect(res.status).toBe(400);
  });

  it('POST /desktop/git-identity rejects a malformed email (400)', async () => {
    const res = await appWith(desktopGitIdentity as AnyRoute[])
      .request('/desktop/git-identity', json({ name: 'Ada', email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('GET /desktop/setup-pty-commands returns the four specs', async () => {
    const res = await appWith(desktopSetupPtyCommands as AnyRoute).request('/desktop/setup-pty-commands');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installRuntime.command).toBeTruthy();
    // Commands are resolved to absolute binary paths (or a `bash -lc` fallback)
    // because the PTY child has no inherited PATH — assert the binary/intent,
    // not a bare name.
    const endsWithOrBash = (cmd: string, bin: string) => cmd === 'bash' || cmd.endsWith(bin);
    expect(endsWithOrBash(body.loginClaude.command, 'claude')).toBe(true);
    expect(endsWithOrBash(body.loginOmp.command, 'omp')).toBe(true);
    expect(endsWithOrBash(body.loginGithub.command, 'gh')).toBe(true);
    // Per-framework installers for ALL three backends, incl. omp (installable
    // cross-platform now via a GitHub-release download).
    expect(body.installFramework.claude?.command).toBeTruthy();
    expect(body.installFramework.codex?.command).toBeTruthy();
    expect(body.installFramework.omp?.command).toBeTruthy();
  });

  it('OPTIONS /desktop/preflight answers the CORS preflight with 204', async () => {
    const res = await appWith(desktopPreflight as AnyRoute[]).request('/desktop/preflight', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('POST /desktop/telemetry-flush returns the flush result', async () => {
    const res = await appWith(desktopTelemetryFlush as AnyRoute).request('/desktop/telemetry-flush', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flushed: 3 });
  });

  it('POST /desktop/telemetry-report rejects when telemetry is disabled (403)', async () => {
    vi.mocked(readOperatorState).mockResolvedValue(null);
    const res = await appWith(desktopTelemetryReport as AnyRoute[])
      .request('/desktop/telemetry-report', json({ kind: 'crash' }));
    expect(res.status).toBe(403);
  });

  it('records allowlisted transport outcomes locally while telemetry is disabled, without entering the telemetry ring', async () => {
    vi.mocked(readOperatorState).mockResolvedValue(null);
    const record = vi.spyOn(fallbackObservations, 'observeFallback').mockReturnValue(true);
    try {
      const app = appWith(desktopTelemetryReport as AnyRoute[]);
      for (const applied of [0, 1]) {
        const res = await app.request('/desktop/telemetry-report', json({ kind: 'fallback-observation', payload: {
          source: 'sync-transport', mechanism: 'browser-sync-transport', eligible: 1, applied,
          reason: applied ? 'applied' : 'preferred-unavailable', scope: 'SSE',
          message: 'secret', stack: '/private', url: 'https://private', workspaceId: 'forged',
        } }));
        expect(res.status).toBe(202);
      }
      expect(record.mock.calls).toEqual([0, 1].map((applied) => ['browser-sync-transport', {
        eligible: 1, applied, reason: applied ? 'applied' : 'preferred-unavailable', scope: 'SSE',
      }, { processTag: 'browser-sync-ingress' }]));
      expect(writeOperatorState).not.toHaveBeenCalled();
      expect(readOperatorState).not.toHaveBeenCalled();
    } finally { record.mockRestore(); }
  });

  it.each([
    { mechanism: 'arbitrary' }, { eligible: 0 }, { eligible: 1000 }, { applied: 2 },
    { applied: 1, reason: 'preferred-unavailable' }, { scope: 'private/user' }, { scope: 'POLLING' },
    { reason: 'raw error secret' }, { source: 'untrusted' },
  ])('rejects malformed transport observations before the durable sink: %j', async (patch) => {
    const record = vi.spyOn(fallbackObservations, 'observeFallback').mockReturnValue(true);
    try {
      const res = await appWith(desktopTelemetryReport as AnyRoute[]).request('/desktop/telemetry-report', json({
        kind: 'fallback-observation', payload: { source: 'sync-transport', mechanism: 'browser-sync-transport',
          eligible: 1, applied: 0, reason: 'preferred-unavailable', scope: 'SSE', ...patch },
      }));
      expect(res.status).toBe(400);
      expect(record).not.toHaveBeenCalled();
    } finally { record.mockRestore(); }
  });

  it('archives only redacted render crashes while telemetry is disabled and deduplicates the ring', async () => {
    const payload = {
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
      component: 'LearningTab', tab: 'learning',
      fingerprint: 'forged', message: 'secret-token=abc', stack: 'private stack',
    };
    const ring: { reports: Array<{ kind: string; payload: unknown; received_at: string }> } = { reports: [] };
    vi.mocked(readOperatorState).mockImplementation(async (key) =>
      key === 'telemetry_reports' ? ring : null,
    );
    vi.mocked(writeOperatorState).mockImplementation(async (key, value) => {
      if (key === 'telemetry_reports') ring.reports = (value as typeof ring).reports;
    });
    const app = appWith(desktopTelemetryReport as AnyRoute[]);
    const first = await app.request('/desktop/telemetry-report', json({ kind: 'crash', payload }));
    expect(first.status).toBe(200);
    expect(ring.reports).toHaveLength(1);
    expect(ring.reports[0]?.payload).toEqual({
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
      component: 'LearningTab', tab: 'learning',
      fingerprint: 'adv-tab:TypeError:LearningTab:learning',
    });
    expect(JSON.stringify(ring)).not.toContain('secret-token');
    const second = await app.request('/desktop/telemetry-report', json({ kind: 'crash', payload }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ deduped: true });
    expect(ring.reports).toHaveLength(1);
  });

  it('rejects malformed render-boundary payloads even when telemetry is enabled', async () => {
    vi.mocked(readOperatorState).mockResolvedValue({ telemetry_enabled: true });
    const res = await appWith(desktopTelemetryReport as AnyRoute[])
      .request('/desktop/telemetry-report', json({
        kind: 'crash',
        payload: { source: 'render-boundary', boundary: 'route', errorType: 'Error', component: '/secret/path', tab: 'other' },
      }));
    expect(res.status).toBe(400);
    expect(vi.mocked(writeOperatorState)).not.toHaveBeenCalledWith('telemetry_reports', expect.anything());
    vi.mocked(readOperatorState).mockReset().mockResolvedValue(null);
  });

  it('POST /desktop/workspace-validate rejects an invalid body with 400', async () => {
    const res = await appWith(desktopWorkspaceValidate as AnyRoute)
      .request('/desktop/workspace-validate', json({ notpath: 1 }));
    expect(res.status).toBe(400);
  });

  it('POST /desktop/workspace-validate accepts an empty path', async () => {
    const res = await appWith(desktopWorkspaceValidate as AnyRoute)
      .request('/desktop/workspace-validate', json({ path: '' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, normalized: '' });
  });

  it('GET /desktop/setup-wizard-state returns the persisted state', async () => {
    const res = await appWith(desktopSetupWizardState as AnyRoute[]).request('/desktop/setup-wizard-state');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step_status: {} });
  });

  it('PATCH /desktop/setup-wizard-state merge-writes', async () => {
    const res = await appWith(desktopSetupWizardState as AnyRoute[])
      .request('/desktop/setup-wizard-state', { ...json({ last_visited_step: 'keys' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(updateOperatorState).toHaveBeenCalledWith('setup_wizard_state', { step_status: {} }, expect.any(Function));
    expect(await res.json()).toMatchObject({ step_status: {}, last_visited_step: 'keys' });
  });
});
