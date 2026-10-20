/**
 * psu-launcher hosted-customer mode (D-002 rules 2 and 4, plan
 * psu-cloud-connector-liveness-multi-signin-2026-09-29 P-008).
 *
 * A psu the workspace host starts for a customer runs as the SERVICE user, so its own launcher
 * re-applies the host's argv allowlist before anything else runs (including `--version` and the
 * connection front controller), and never prompts for identity, fleet or a backend install.
 *
 * Only refused argv is launched here: an admitted one would start a real session.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureBackendInstalled, pickFleet, pickIdentity } from './psu-launcher.mjs';

const { confirm, select } = vi.hoisted(() => ({ confirm: vi.fn(), select: vi.fn() }));
vi.mock('@inquirer/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inquirer/prompts')>()),
  confirm,
  select,
}));

// The maintained copy-out mutation probe supplies its mirror path; Node's committed-source
// loader remains active in the child, and ordinary suite runs use the installed source path.
const LAUNCHER = process.env.PSU_LAUNCHER_TEST_PATH || fileURLToPath(new URL('./psu-launcher.mjs', import.meta.url));

function launch(argv: string[]) {
  return spawnSync(process.execPath, [LAUNCHER, ...argv], {
    // An unroutable operator: a gate that let an argument through would fail loudly, not launch.
    env: { ...process.env, PAPERCUSP_PSU_HOSTED_CUSTOMER: '1', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('psu launcher in hosted-customer mode (D-002)', () => {
  it.each([
    [['--version'], '--version'],
    [['--launch-context=/etc/shadow'], '--launch-context'],
    [['--connect=portal.example.test/ws'], '--connect'],
    [['--fleet=ops'], '--fleet'],
    [['--', 'claude'], '--'],
    [['--agent', 'bash'], 'flag_value_refused:--agent'],
  ])('refuses %j before doing anything else', (argv, named) => {
    const result = launch(argv);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('psu: this cloud workspace does not accept these arguments');
    expect(result.stderr).toContain(named);
  });

  describe('prompts', () => {
    const saved = process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
    afterEach(() => {
      if (saved === undefined) delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
      else process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = saved;
      select.mockReset();
      vi.restoreAllMocks();
    });

    function stubIdentityOptions() {
      return vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ identities: [], unreadable: [] }), { status: 200 }));
    }

    it('launches as plain su without asking for an identity or calling the operator', async () => {
      process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = '1';
      const fetchSpy = stubIdentityOptions();
      await expect(pickIdentity('ws', 'h')).resolves.toEqual({ stack: [], selectedIdentityRevision: null });
      expect(select).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('outside hosted-customer mode the same launch shows the identity picker (positive control)', async () => {
      delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
      const fetchSpy = stubIdentityOptions();
      select.mockResolvedValueOnce('su');
      await expect(pickIdentity('ws', 'h')).resolves.toEqual({ stack: [], selectedIdentityRevision: null });
      expect(select).toHaveBeenCalledTimes(1);
      expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: 'Identity', default: 'su' }));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(requested.pathname).toBe('/api/agent-mcp/console/bootstrap-su/options');
      expect(requested.searchParams.get('identities')).toBe('1');
      expect(requested.searchParams.get('workspace')).toBe('ws');
      expect(requested.searchParams.get('harness')).toBe('h');
    });

    describe('fleet', () => {
      const noFleet = { slug: null, role: null, name: null, scheme: null };
      afterEach(() => {
        select.mockReset();
        vi.restoreAllMocks();
      });

      function stubFleetOptions() {
        return vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response(JSON.stringify({ fleets: [], schemes: [] }), { status: 200 }));
      }

      it('joins no fleet without asking the operator or showing the fleet picker', async () => {
        process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = '1';
        const fetchSpy = stubFleetOptions();
        await expect(pickFleet('ws')).resolves.toEqual(noFleet);
        expect(select).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('outside hosted-customer mode the same launch shows the fleet picker (positive control)', async () => {
        delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
        const fetchSpy = stubFleetOptions();
        select.mockResolvedValueOnce(null);
        await expect(pickFleet('ws')).resolves.toEqual(noFleet);
        expect(select).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/bootstrap-su/options');
      });
    });
  });

  // D-002 rule 2: the installer would run as the service user, so a hosted customer's psu never offers it.
  describe('backend install', () => {
    const saved = process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
    afterEach(() => {
      if (saved === undefined) delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
      else process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = saved;
      confirm.mockReset();
      vi.restoreAllMocks();
    });

    function stubInstallerFetch() {
      return vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ installFramework: {} }), { status: 200 }));
    }

    it('refuses a missing backend by name, without prompting or fetching an installer', async () => {
      process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = '1';
      const fetchSpy = stubInstallerFetch();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(ensureBackendInstalled('codex', { interactive: true, detect: () => null })).resolves.toBe(false);
      const said = errors.mock.calls.map((call) => String(call[0])).join('\n');
      expect(said).toContain("this cloud workspace's agent toolchain has no");
      expect(said).toContain('choose another agent with --agent');
      expect(confirm).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('outside hosted-customer mode prompts and runs the local installer without an operator fetch', async () => {
      delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
      const fetchSpy = stubInstallerFetch();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      confirm.mockResolvedValueOnce(true);
      const installer = vi.fn(() => ({ command: 'test-installer', args: [], cwd: '/tmp', env: {} }));
      const runInstaller = vi.fn(async () => 1);
      await expect(ensureBackendInstalled('codex', {
        interactive: true, detect: () => null, installer, runInstaller,
      })).resolves.toBe(false);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(installer).toHaveBeenCalledWith('codex', process.platform, expect.any(String));
      expect(runInstaller).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
