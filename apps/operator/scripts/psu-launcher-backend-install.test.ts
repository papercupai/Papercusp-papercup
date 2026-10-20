import { delimiter, dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENTS, agentPickerChoices, backendAvailability, detectBackendBin, ensureBackendInstalled,
  offerBackendInstallation, pickAgent,
} from './psu-launcher.mjs';
import { buildFrameworkInstallSpec } from '../../../packages/operator-core/lib/framework-install-spec.mjs';
import { backendBinOverrideEnvKey } from '../../../packages/operator-core/lib/backend-bin-resolve.mjs';

const { confirm, checkbox } = vi.hoisted(() => ({ confirm: vi.fn(), checkbox: vi.fn() }));
vi.mock('@inquirer/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inquirer/prompts')>()), confirm, checkbox,
}));

const originalPath = process.env.PATH;
const hostedCustomer = process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
const fakeBin = (agent: string) => ({ path: join(tmpdir(), 'psu-install-test-bin', agent), onPath: false });

beforeEach(() => {
  delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  confirm.mockReset();
  checkbox.mockReset();
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (hostedCustomer === undefined) delete process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER;
  else process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = hostedCustomer;
  vi.restoreAllMocks();
});

describe('startup backend availability', () => {
  it('checks all three backends and keeps missing backends selectable with installation labels', () => {
    const detect = vi.fn((agent: string) => agent === 'codex' ? fakeBin(agent) : null);
    const availability = backendAvailability({ detect });
    expect(detect.mock.calls.map(([agent]) => agent)).toEqual(AGENTS);
    expect(availability).toEqual({ claude: false, omp: false, codex: true });
    const choices = agentPickerChoices({ availability });
    expect(choices.map((choice) => choice.value)).toEqual([...AGENTS, 'pui']);
    expect(choices.find((choice) => choice.value === 'claude')?.name).toContain('install on selection');
    expect(choices.find((choice) => choice.value === 'codex')?.name).toContain('(installed)');
    expect(choices.every((choice) => !('disabled' in choice))).toBe(true);
  });

  it('lets someone with only one backend decline optional installations', async () => {
    const ensure = vi.fn();
    confirm.mockResolvedValue(false);
    expect(await offerBackendInstallation({
      interactive: true, detect: (agent) => agent === 'omp' ? fakeBin(agent) : null, ensure,
    })).toEqual({ claude: false, omp: true, codex: false });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('continue') }));
    expect(checkbox).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('allows installing just one backend when none is installed and rechecks availability', async () => {
    const installed = new Set<string>();
    const detect = (agent: string) => installed.has(agent) ? fakeBin(agent) : null;
    const ensure = vi.fn(async (agent: string) => { installed.add(agent); return true; });
    confirm.mockResolvedValue(true);
    checkbox.mockResolvedValue(['codex']);
    expect(await offerBackendInstallation({ interactive: true, detect, ensure })).toEqual({
      claude: false, omp: false, codex: true,
    });
    expect(confirm.mock.calls[0][0].message).toContain('No AI backend');
    expect(ensure).toHaveBeenCalledWith('codex', { interactive: true, detect, confirmInstall: false });
  });

  it('offers only missing backends and preserves the installed one when an optional install fails', async () => {
    confirm.mockResolvedValue(true);
    checkbox.mockResolvedValue(['claude']);
    const ensure = vi.fn(async () => false);
    const availability = await offerBackendInstallation({
      interactive: true, detect: (agent) => agent === 'codex' ? fakeBin(agent) : null, ensure,
    });
    expect(checkbox.mock.calls[0][0].choices.map((choice: {value: string}) => choice.value)).toEqual(['claude', 'omp']);
    expect(availability.codex).toBe(true);
    expect(availability.claude).toBe(false);
  });

  it('can leave optional installs unselected and choose an installation from the agent menu instead', async () => {
    confirm.mockResolvedValue(true);
    checkbox.mockResolvedValue([]);
    const ensure = vi.fn();
    await offerBackendInstallation({ interactive: true, detect: () => null, ensure });
    expect(ensure).not.toHaveBeenCalled();
  });

  it.each(['all-installed', 'noninteractive', 'hosted-customer'])(
    'does not prompt or install for %s', async (mode) => {
      if (mode === 'hosted-customer') process.env.PAPERCUSP_PSU_HOSTED_CUSTOMER = '1';
      const ensure = vi.fn();
      await offerBackendInstallation({
        interactive: mode !== 'noninteractive',
        detect: mode === 'all-installed' ? fakeBin : () => null,
        ensure,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
    },
  );
});

describe('selected backend installation', () => {
  it.skipIf(process.platform === 'win32')('runs a real installer subprocess and launches its new executable without a shell restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-real-install-'));
    try {
      const bin = join(root, 'codex');
      const detect = () => detectBackendBin('codex', {
        home: root, env: { PATH: '', [backendBinOverrideEnvKey('codex')]: bin },
      });
      expect(detect()).toBeNull();
      const script = `require('node:fs').writeFileSync(${JSON.stringify(bin)}, ${JSON.stringify('#!/bin/sh\nprintf "test-codex 1.0\\n"\n')}, {mode: 0o755})`;
      expect(await ensureBackendInstalled('codex', {
        interactive: true, confirmInstall: false, detect,
        installer: () => ({ command: process.execPath, args: ['-e', script], cwd: root, env: {} }),
      })).toBe(true);
      const launched = spawnSync('codex', ['--version'], { encoding: 'utf8' });
      expect(launched.status).toBe(0);
      expect(launched.stdout).toBe('test-codex 1.0\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['claude', 'codex', 'omp'] as const)('installs %s locally, verifies it, and refreshes PATH immediately', async (agent) => {
    let installed = false;
    const detect = vi.fn(() => installed ? fakeBin(agent) : null);
    const installer = vi.fn(buildFrameworkInstallSpec);
    const runInstaller = vi.fn(async () => { installed = true; return 0; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    confirm.mockResolvedValue(true);
    expect(await ensureBackendInstalled(agent, { interactive: true, detect, installer, runInstaller })).toBe(true);
    expect(installer).toHaveBeenCalledWith(agent, process.platform, expect.any(String));
    expect(runInstaller).toHaveBeenCalledWith(expect.objectContaining({ command: expect.any(String), args: expect.any(Array) }));
    expect(detect).toHaveBeenCalledTimes(2);
    expect(process.env.PATH?.split(delimiter)[0]).toBe(dirname(fakeBin(agent).path));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not install an already present backend', async () => {
    const runInstaller = vi.fn();
    expect(await ensureBackendInstalled('codex', { detect: () => fakeBin('codex'), runInstaller })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it('does not run an installer after declining or in a noninteractive launch', async () => {
    const runInstaller = vi.fn();
    confirm.mockResolvedValue(false);
    expect(await ensureBackendInstalled('codex', { interactive: true, detect: () => null, runInstaller })).toBe(false);
    expect(await ensureBackendInstalled('omp', { interactive: false, detect: () => null, runInstaller })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it('does not claim success when an installer exits successfully without installing the backend', async () => {
    expect(await ensureBackendInstalled('codex', {
      interactive: true, confirmInstall: false, detect: () => null, runInstaller: async () => 0,
    })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("still isn't detected"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a failed installer without trapping the picker in an exception', async () => {
    expect(await ensureBackendInstalled('codex', {
      interactive: true, confirmInstall: false, detect: () => null,
      runInstaller: async () => { throw new Error('download unavailable'); },
    })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('download unavailable'));
  });
});

describe('backend picker recovery', () => {
  it('installs a missing backend before returning the selection', async () => {
    const ensure = vi.fn(async () => true);
    const select = vi.fn(async () => 'codex');
    expect(await pickAgent({ detect: () => null, ensure, select })).toBe('codex');
    expect(ensure).toHaveBeenCalledWith('codex', { detect: expect.any(Function), confirmInstall: false });
  });

  it('lets the user choose an installed backend after declining or failing another installation', async () => {
    const ensure = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const select = vi.fn().mockResolvedValueOnce('claude').mockResolvedValueOnce('codex');
    expect(await pickAgent({ detect: (agent) => agent === 'codex' ? fakeBin(agent) : null, ensure, select })).toBe('codex');
    expect(select).toHaveBeenCalledTimes(2);
    expect(ensure.mock.calls.map(([agent]) => agent)).toEqual(['claude', 'codex']);
  });

  it('passes the PUI destination through without trying to install it as an AI backend', async () => {
    const ensure = vi.fn();
    expect(await pickAgent({ detect: () => null, ensure, select: async () => 'pui' })).toBe('pui');
    expect(ensure).not.toHaveBeenCalled();
  });
});
