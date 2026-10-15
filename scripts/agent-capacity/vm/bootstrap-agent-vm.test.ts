import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'bootstrap-agent-vm.sh');

describe('bootstrap-agent-vm.sh (DRY_RUN)', () => {
  let root: string;
  let tasks: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'capboot-'));
    tasks = path.join(root, 'tasks.json');
    writeFileSync(
      tasks,
      JSON.stringify({
        version: 1,
        repos: {
          webapp: { url: 'https://example.test/webapp.git', sha: 'aaa111', kind: 'ts', setup: ['yarn install --frozen-lockfile', 'yarn build'] },
          service: { url: 'https://example.test/service.git', sha: 'bbb222', kind: 'py', systemPackages: ['libfoo-dev', 'libbar-dev'], setup: ['uv sync --frozen'] },
        },
        tasks: [],
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const boot = (env: Record<string, string>) =>
    spawnSync('bash', [SCRIPT, tasks], { encoding: 'utf8', env: { ...process.env, DRY_RUN: '1', AGENT_CAPACITY_CACHE: path.join(root, 'cache'), ...env } });

  it('pins the recorded CLI versions and builds every repo at its sha with its own setup, in order', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2' });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.at(-1)).toBe('BOOTSTRAP_OK');
    const runs = lines.filter((l) => l.startsWith('RUN ')).map((l) => l.slice(4));
    expect(runs.find((l) => l.includes('apt-get install'))).toMatch(/ libbar-dev libfoo-dev$/);
    expect(runs).toContain('sudo npm install -g --no-fund --no-audit @anthropic-ai/claude-code@2.1.284 @openai/codex@0.159.2');
    const prepared = path.join(root, 'cache', 'prepared');
    const repoRuns = runs.filter((l) => l.includes(prepared) && !l.startsWith('mkdir'));
    expect(repoRuns).toEqual([
      `git clone --quiet https://example.test/service.git ${prepared}/service`,
      `git -C ${prepared}/service checkout --quiet --detach bbb222`,
      `bash -c cd '${prepared}/service' && uv sync --frozen`,
      `git clone --quiet https://example.test/webapp.git ${prepared}/webapp`,
      `git -C ${prepared}/webapp checkout --quiet --detach aaa111`,
      `bash -c cd '${prepared}/webapp' && yarn install --frozen-lockfile`,
      `bash -c cd '${prepared}/webapp' && yarn build`,
    ]);
  });

  it('downloads the Node build for the machine arch (x64, arm64 for c4a/t2a) and refuses any other arch', () => {
    const nodeUrl = (stdout: string) =>
      stdout.split('\n').find((l) => l.startsWith('RUN ') && l.includes('nodejs.org')) ?? '';
    const x64 = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', MACHINE_ARCH: 'x86_64' });
    expect(x64.status).toBe(0);
    expect(nodeUrl(x64.stdout)).toMatch(/node-v[\d.]+-linux-x64\.tar\.xz /);
    const arm = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', MACHINE_ARCH: 'aarch64' });
    expect(arm.status).toBe(0);
    expect(nodeUrl(arm.stdout)).toMatch(/node-v[\d.]+-linux-arm64\.tar\.xz /);
    const other = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', MACHINE_ARCH: 's390x' });
    expect(other.status).toBe(7);
    expect(other.stderr).toContain('BOOTSTRAP_FAILED no Node build for machine arch s390x');
    expect(nodeUrl(other.stdout)).toBe('');
  });

  it('bounds every apt fetch with a timeout and retries, so one stalled mirror connection cannot hang the bring-up', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2' });
    expect(r.status).toBe(0);
    const apt = r.stdout.split('\n').filter((l) => l.startsWith('RUN ') && l.includes('apt-get'));
    expect(apt.length).toBe(2);
    for (const l of apt) {
      expect(l).toMatch(/ -o Acquire::http::Timeout=30(?: |$)/);
      expect(l).toMatch(/ -o Acquire::https::Timeout=30(?: |$)/);
      expect(l).toMatch(/ -o Acquire::Retries=5(?: |$)/);
    }
  });

  it('without CACHE_XFS_GB, leaves the cache on the boot disk (no xfsprogs, no mount)', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/xfsprogs|mkfs\.xfs|mount -o loop|fallocate|\/etc\/fstab/);
  });

  it('with CACHE_XFS_GB, mounts a reflink XFS volume at the cache before anything is cloned into it', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', CACHE_XFS_GB: '80' });
    expect(r.status).toBe(0);
    const runs = r.stdout.trim().split('\n').filter((l) => l.startsWith('RUN ')).map((l) => l.slice(4));
    const cache = path.join(root, 'cache');
    const img = `${cache}.xfs.img`;
    const at = (needle: string) => {
      const i = runs.findIndex((l) => l.includes(needle));
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(runs.find((l) => l.includes('apt-get install'))).toMatch(/ xfsprogs /);
    const mounted = at(`sudo mount -o loop ${img} ${cache}`);
    expect(at(`fallocate -l 80G ${img}`)).toBeLessThan(mounted);
    expect(at(`mkfs.xfs -q -m reflink=1 ${img}`)).toBeLessThan(mounted);
    expect(at('apt-get install')).toBeLessThan(mounted);
    // The writable mount must exist before the cache is populated, or the clones land on the
    // boot disk underneath it and the replays copy instead of reflinking.
    const owned = at(`sudo chown `);
    expect(runs[owned]).toMatch(new RegExp(`^sudo chown \\d+:\\d+ ${cache}$`));
    expect(owned).toBeGreaterThan(mounted);
    expect(owned).toBeLessThan(at(`mkdir -p ${cache}/prepared`));
    expect(owned).toBeLessThan(at('git clone'));
    // P-007: the mount must survive a restart (a spot reclaim), so it is persisted in fstab with
    // nofail, idempotently, after the mount it describes.
    const fstab = at('/etc/fstab');
    expect(runs[fstab]).toContain(`grep -qsF '${img} ${cache} ' /etc/fstab ||`);
    expect(runs[fstab]).toContain(`echo '${img} ${cache} xfs loop,nofail 0 0' >> /etc/fstab`);
    expect(fstab).toBeGreaterThan(mounted);
  });

  it.each(['abc', '0', '-5', '1.5'])('refuses CACHE_XFS_GB=%s before running anything', (gb) => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', CACHE_XFS_GB: gb });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BOOTSTRAP_FAILED CACHE_XFS_GB/);
    expect(r.stdout).not.toMatch(/RUN /);
  });

  it('refuses to mount over a non-empty cache dir that would be hidden by the mount', () => {
    const cache = path.join(root, 'cache');
    mkdirSync(path.join(cache, 'corpus'), { recursive: true });
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', CACHE_XFS_GB: '80' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not empty/);
    expect(r.stdout).not.toMatch(/RUN /);
  });

  it('refuses to start without the recorded CLI versions', () => {
    const r = boot({ CODEX_VERSION: '0.159.2' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/CLAUDE_VERSION/);
    expect(r.stdout).not.toMatch(/RUN /);
  });

  // EI-21417256075155406: a missing skills root makes Codex watch /etc and $HOME with IN_OPEN.
  const skillRootRuns = (stdout: string) =>
    stdout.split('\n').filter((l) => l.startsWith('RUN ') && l.includes('skills')).map((l) => l.slice(4));

  it('creates the Codex skills roots by default, after Codex is installed, and reports the setting', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', HOME: root });
    expect(r.status).toBe(0);
    expect(skillRootRuns(r.stdout)).toEqual([
      'sudo mkdir -p /etc/codex/skills',
      `mkdir -p ${root}/.agents/skills ${root}/.codex/skills`,
    ]);
    const lines = r.stdout.trim().split('\n');
    expect(lines.indexOf('RUN sudo mkdir -p /etc/codex/skills')).toBeGreaterThan(lines.findIndex((l) => l.includes('npm install -g')));
    expect(lines.slice(-2)).toEqual(['CODEX_SKILL_ROOTS=create', 'BOOTSTRAP_OK']);
  });

  // Plan D-012 / WI-10004618: on Ubuntu 24.04 (apparmor_restrict_unprivileged_userns=1) an
  // unconfined bwrap gets no user namespace, so every Codex tool call fails silently. bubblewrap
  // alone did not fix it on the P-005 VMs; the profile granting `userns` did.
  it('installs bubblewrap and loads an AppArmor profile granting /usr/bin/bwrap user namespaces, after apt', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2' });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    const install = lines.findIndex((l) => l.startsWith('RUN ') && l.includes('apt-get install'));
    expect(lines[install].split(' ')).toContain('bubblewrap');
    const write = lines.indexOf('RUN write /etc/apparmor.d/bwrap');
    expect(write).toBeGreaterThan(install);
    const profile = lines.slice(write + 1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('FILE '))).map((l) => l.slice(5));
    expect(profile).toContain('profile bwrap /usr/bin/bwrap flags=(unconfined) {');
    expect(profile.map((l) => l.trim())).toContain('userns,');
    expect(profile.at(-1)).toBe('}');
    expect(lines.indexOf('RUN sudo apparmor_parser -r /etc/apparmor.d/bwrap')).toBe(write + 1 + profile.length);
  });

  it('CODEX_SKILL_ROOTS=leave keeps the as-shipped baseline, and a bad value is refused before anything runs', () => {
    const leave = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', CODEX_SKILL_ROOTS: 'leave' });
    expect(leave.status).toBe(0);
    expect(skillRootRuns(leave.stdout)).toEqual([]);
    expect(leave.stdout).toMatch(/^CODEX_SKILL_ROOTS=leave$/m);

    const bad = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2', CODEX_SKILL_ROOTS: 'yes' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/CODEX_SKILL_ROOTS must be create or leave/);
    expect(bad.stdout).not.toMatch(/RUN /);
  });
});
