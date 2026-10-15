/**
 * `hosted-public-ingress-probe` system action (WI-10004437) — the standing tripwire for the hosted
 * origin's tunnel ingress.
 *
 * Two halves, as in hosted-lifecycle-reconcile-action.test.ts:
 * 1. behaviour — a finding (config or live) THROWS, so the routine-failure watchdog sees it; an
 *    absent config is reported, not raised; a probe that measured nothing is never a pass;
 * 2. wiring — registered, imported, classified, listed in the bespoke-active-seed registry and
 *    seeded under the role it registers. A tripwire nothing arms is indistinguishable from a quiet
 *    ingress, which is the silent nothing this item exists to end.
 *
 * The config cases feed REAL cloudflared YAML through the real audit, so they exercise the same
 * parser and router the routine runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TARGET_ROLE_SPEND } from '../../automation/routine-classification';
import { hostedIngressSamples } from '../../endpoint-route/hosted-public-ingress';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';
import {
  DEFAULT_HOSTED_INGRESS_SERVICE,
  DEFAULT_HOSTED_PUBLIC_ORIGIN,
  HOSTED_PUBLIC_INGRESS_PROBE,
  hostedPublicIngressProbeConfig,
  makeHostedPublicIngressProbeAction,
  type HostedPublicIngressProbeDeps,
} from './hosted-public-ingress-probe-action';

const HERE = __dirname;
const ACTION_FILE = join(HERE, 'hosted-public-ingress-probe-action.ts');
const SEED_FILE = join(HERE, 'seed-hosted-public-ingress-probe-routine.ts');
const REGISTER_FILE = join(HERE, 'register-system-actions.ts');

const ACTION_NAME = 'hosted-public-ingress-probe';
const TARGET_ROLE = `system:${ACTION_NAME}`;

const read = (p: string) => readFileSync(p, 'utf8');

const ctx = () => ({ workspaceId: 'ws-1', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

const CONFIG = {
  origin: 'https://app.example.test',
  configPath: '/nonexistent/papercup-demos.yml',
  controlPlaneService: 'http://localhost:3880',
};

// One exact rule per plane sample (derived from the module's own sample set, so the provider-only
// families stay unpublished), then the portal catch-all: a config the audit passes. JSON strings
// are valid YAML double-quoted scalars, so the regex escapes survive the parser.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLANE_SAMPLES = hostedIngressSamples().filter((s) => s.expect === 'control-plane');
const HEALTHY_YAML = [
  'tunnel: t',
  'ingress:',
  ...PLANE_SAMPLES.map(
    (s) =>
      `  - hostname: app.example.test\n    path: ${JSON.stringify(`^${escapeRegex(s.path)}$`)}\n    service: http://localhost:3880`,
  ),
  '  - hostname: app.example.test',
  '    service: http://localhost:3801',
  '  - service: http_status:404',
].join('\n');

// Only the portal catch-all: every plane family falls through to the session gate.
const BROKEN_YAML = `
tunnel: t
ingress:
  - hostname: app.example.test
    service: http://localhost:3801
  - service: http_status:404
`;

const cleanLive: HostedPublicIngressProbeDeps['probe'] = async () => ({ checked: 36, findings: [] });

function deps(overrides: Partial<HostedPublicIngressProbeDeps>): Partial<HostedPublicIngressProbeDeps> {
  return { config: () => CONFIG, readConfig: async () => null, probe: cleanLive, log: vi.fn(), ...overrides };
}

describe('hosted-public-ingress-probe system action', () => {
  it('logs a summary with both counts when the config and the live origin are clean', async () => {
    const log = vi.fn();
    const action = makeHostedPublicIngressProbeAction(deps({ readConfig: async () => HEALTHY_YAML, log }));

    await action(ctx());

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^app\.example\.test: config=checked=\d+ findings=0 live checked=36 findings=0$/);
  });

  it('probes the configured origin', async () => {
    const probe = vi.fn(cleanLive);
    await makeHostedPublicIngressProbeAction(deps({ probe }))(ctx());
    expect(probe).toHaveBeenCalledWith({ origin: CONFIG.origin });
  });

  it('a config with no plane rules THROWS and names the stranded routes', async () => {
    // The incident shape: the plane's families fall through to the portal catch-all.
    const action = makeHostedPublicIngressProbeAction(deps({ readConfig: async () => BROKEN_YAML }));

    await expect(action(ctx())).rejects.toThrow(/not-routed-to-control-plane -> http:\/\/localhost:3801/);
  });

  it('CALIBRATION: the healthy config really is judged — the broken one differs only in its rules', async () => {
    // Without this, a config half that never ran would pass the healthy case vacuously.
    expect(PLANE_SAMPLES.length).toBeGreaterThan(10);
    const healthy = makeHostedPublicIngressProbeAction(deps({ readConfig: async () => HEALTHY_YAML }));
    await expect(healthy(ctx())).resolves.toBeUndefined();
    // Drop ONE plane rule and the same config fails: the audit is judging rule by rule.
    const oneMissing = HEALTHY_YAML.replace(/ {2}- hostname: app\.example\.test\n {4}path: "[^"]+"\n {4}service: http:\/\/localhost:3880\n/, '');
    expect(oneMissing).not.toBe(HEALTHY_YAML);
    const broken = makeHostedPublicIngressProbeAction(deps({ readConfig: async () => oneMissing }));
    await expect(broken(ctx())).rejects.toThrow(/1 public route\(s\)/);
  });

  it('a live portal-gate answer THROWS with the path and status', async () => {
    const action = makeHostedPublicIngressProbeAction(
      deps({
        probe: async () => ({
          checked: 36,
          findings: [
            {
              family: 'auth',
              path: '/api/auth/workos/webhook',
              status: 401,
              problem: 'portal-session-gate',
              detail: '{"error":"portal_auth_required"}',
            },
          ],
        }),
      }),
    );

    await expect(action(ctx())).rejects.toThrow(
      /1 public route\(s\) do not reach the hosted control plane.*live GET \/api\/auth\/workos\/webhook \[auth\] portal-session-gate status=401/,
    );
  });

  it('an unreachable sample THROWS too — an origin that cannot be reached is not a pass', async () => {
    const action = makeHostedPublicIngressProbeAction(
      deps({
        probe: async () => ({
          checked: 36,
          findings: [{ family: 'mcp', path: '/api/x', status: null, problem: 'unreachable', detail: 'fetch failed (ECONNRESET)' }],
        }),
      }),
    );

    await expect(action(ctx())).rejects.toThrow(/unreachable status=none fetch failed \(ECONNRESET\)/);
  });

  it('an absent config is reported in the summary, not raised — the live probe still runs', async () => {
    const log = vi.fn();
    const probe = vi.fn(cleanLive);
    await makeHostedPublicIngressProbeAction(deps({ readConfig: async () => null, probe, log }))(ctx());

    expect(probe).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(`config=absent(${CONFIG.configPath})`);
  });

  it('a config read failure other than absence THROWS', async () => {
    const action = makeHostedPublicIngressProbeAction(
      deps({
        readConfig: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      }),
    );
    await expect(action(ctx())).rejects.toThrow('EACCES');
  });

  it('the default reader returns null for a missing file rather than throwing', async () => {
    const log = vi.fn();
    const action = makeHostedPublicIngressProbeAction({
      config: () => ({ ...CONFIG, configPath: join(HERE, 'no-such-cloudflared-config.yml') }),
      probe: cleanLive,
      log,
    });
    await action(ctx());
    expect(log.mock.calls[0][0]).toContain('config=absent(');
  });

  it('a live probe that checked ZERO samples THROWS — an empty sample set is not a clean pass', async () => {
    const action = makeHostedPublicIngressProbeAction(deps({ probe: async () => ({ checked: 0, findings: [] }) }));
    await expect(action(ctx())).rejects.toThrow(/checked zero samples/);
  });

  it('config resolves from env with this deployment as the default', () => {
    expect(hostedPublicIngressProbeConfig({})).toMatchObject({
      origin: DEFAULT_HOSTED_PUBLIC_ORIGIN,
      controlPlaneService: DEFAULT_HOSTED_INGRESS_SERVICE,
    });
    expect(hostedPublicIngressProbeConfig({}).configPath).toMatch(/\.cloudflared\/papercup-demos\.yml$/);
    expect(
      hostedPublicIngressProbeConfig({
        PAPERCUSP_HOSTED_PUBLIC_ORIGIN: 'https://other.test',
        PAPERCUSP_HOSTED_INGRESS_CONFIG: '/etc/c.yml',
        PAPERCUSP_HOSTED_INGRESS_SERVICE: 'http://localhost:9',
      }),
    ).toEqual({ origin: 'https://other.test', configPath: '/etc/c.yml', controlPlaneService: 'http://localhost:9' });
    expect(hostedPublicIngressProbeConfig({ PAPERCUSP_HOSTED_PUBLIC_ORIGIN: '  ' }).origin).toBe(DEFAULT_HOSTED_PUBLIC_ORIGIN);
  });
});

describe('the probe is actually wired in, not merely written', () => {
  it('the action module registers under the expected name', () => {
    expect(read(ACTION_FILE)).toContain('registerSystemAction(HOSTED_PUBLIC_INGRESS_PROBE');
    expect(HOSTED_PUBLIC_INGRESS_PROBE).toBe(ACTION_NAME);
  });

  it('register-system-actions imports it — without this the action never registers', () => {
    expect(read(REGISTER_FILE)).toContain(`import './hosted-public-ingress-probe-action';`);
  });

  it('NEGATIVE CONTROL: the import pin would fail for a module that is not wired', () => {
    expect(read(REGISTER_FILE)).not.toContain(`import './hosted-public-ingress-probe-action-NOT-WIRED';`);
  });

  it('the seeder targets the role the action registers', () => {
    expect(existsSync(SEED_FILE)).toBe(true);
    const src = read(SEED_FILE);
    expect(src).toContain(`const TARGET_ROLE = '${TARGET_ROLE}'`);
    expect(src).toContain(`const NAME = '${ACTION_NAME}'`);
    expect(read(ACTION_FILE)).not.toContain(`registerSystemAction('${TARGET_ROLE}'`);
  });

  it('it is listed in the bespoke ACTIVE seeds registry', () => {
    const entry = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === ACTION_NAME);
    expect(entry, `${ACTION_NAME} is missing from BESPOKE_ACTIVE_SEEDS`).toBeTruthy();
    expect(entry!.seedScript).toBe('seed-hosted-public-ingress-probe-routine.ts');
    expect(existsSync(join(HERE, entry!.seedScript))).toBe(true);
  });

  it('it carries a spend classification', () => {
    expect(TARGET_ROLE_SPEND[TARGET_ROLE]?.spend).toBe('none');
  });

  it('is seeded as an ACTIVE ephemeral interval routine that a re-seed cannot unpause', () => {
    const src = read(SEED_FILE);
    expect(src).toContain(`'ephemeral'`);
    expect(src).toContain('interval_sec');
    expect(src).toContain(`const active = !process.argv.includes('--inactive')`);
    expect(src).toContain('active intentionally NOT re-applied on conflict');
  });
});
