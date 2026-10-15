/**
 * One bootc image serves every cloud (P-307): bake-cloud-images.sh renders the GCE disk, the
 * AWS AMI disk and the Azure VHD from the same CentOS Stream 10 image. Each cloud's release
 * contract names the guest packages that image must carry, and the release gates check
 * them by RPM name. A name the image does not install can never pass a real release gate
 * (WI-10005605 fixed AWS; WI-10005618 fixed GCP and Azure). These tests pin every
 * contract to what infra/images/bootc/workspace-host.Containerfile actually installs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET,
  WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES,
} from '@papercusp/deployment-driver';

import { AWS_AMI_REQUIRED_GUEST_TOOLS } from './aws-ami-release';
import { AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS } from './azure-compute-gallery-release';
import { GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS } from './gcp-image-family';

const BOOTC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'images', 'bootc');
const CONTAINERFILE = join(BOOTC_DIR, 'workspace-host.Containerfile');

/** Ubuntu/Debian package names that have no package of that name on CentOS Stream 10. */
const DEBIAN_ONLY_NAMES = ['ufw', 'unattended-upgrades', 'walinuxagent', 'aws-ssm-agent'];

/**
 * amazon-ssm-agent is installed from AWS's digest-pinned standalone RPM, not the dnf list;
 * aws-ami-scan.test.ts pins that path.
 */
const INSTALLED_OUTSIDE_DNF_LIST: Readonly<Record<string, string>> = {
  'amazon-ssm-agent': 'standalone AWS RPM, pinned by aws-ami-scan.test.ts',
};

const NOT_IN_DNF_LIST = INSTALLED_OUTSIDE_DNF_LIST;

const CONTRACTS = {
  aws: AWS_AMI_REQUIRED_GUEST_TOOLS,
  gcp: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  azure: AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS,
} as const;

function installedByName(containerfile: string, pkg: string): boolean {
  return new RegExp(`^\\s+${pkg.replace(/[-+.]/g, '\\$&')}\\s*\\\\?$`, 'm').test(containerfile);
}

describe('bootc guest-tool contracts (WI-10005618)', () => {
  const containerfile = readFileSync(CONTAINERFILE, 'utf8');

  it('no cloud contract requires a Debian-only package name', () => {
    for (const [cloud, tools] of Object.entries(CONTRACTS)) {
      for (const name of DEBIAN_ONLY_NAMES) {
        expect(tools as readonly string[], `${cloud} still requires ${name}`).not.toContain(name);
      }
    }
  });

  it('every required tool of every cloud is installed by name in the bootc image', () => {
    for (const [cloud, tools] of Object.entries(CONTRACTS)) {
      for (const tool of tools) {
        if (tool in NOT_IN_DNF_LIST) continue;
        expect(installedByName(containerfile, tool), `${cloud} requires ${tool}, not installed`).toBe(true);
      }
    }
  });

  it('installs Azure Linux Agent with its Azure-only guard and host-prepare ordering', () => {
    expect(installedByName(containerfile, 'WALinuxAgent')).toBe(true);
    expect(containerfile).toContain("grep -Fqx 'ConditionVirtualization=|microsoft' /usr/lib/systemd/system/waagent.service");
    expect(containerfile).toContain("grep -Fxq 'Provisioning.Agent=auto' /etc/waagent.conf");
    expect(containerfile).toContain('systemctl enable waagent.service');
    expect(containerfile.indexOf('COPY papercusp-waagent-host-prepare.conf')).toBeGreaterThan(
      containerfile.indexOf('rpm -q WALinuxAgent WALinuxAgent-udev azure-vm-utils'),
    );

    const dropIn = join(BOOTC_DIR, 'papercusp-waagent-host-prepare.conf');
    expect(existsSync(dropIn)).toBe(true);
    expect(readFileSync(dropIn, 'utf8')).toMatch(/^Wants=papercusp-host-prepare\.service$/m);
    expect(readFileSync(dropIn, 'utf8')).toMatch(/^After=papercusp-host-prepare\.service$/m);
    expect(containerfile).toMatch(
      /^COPY papercusp-waagent-host-prepare\.conf \/usr\/lib\/systemd\/system\/waagent\.service\.d\/papercusp-host-prepare\.conf$/m,
    );
  });

  it('the matcher is calibrated: it finds a known package and rejects a substring', () => {
    expect(installedByName(containerfile, 'nftables')).toBe(true);
    expect(installedByName(containerfile, 'dnf-automatic')).toBe(true);
    expect(installedByName(containerfile, 'google-guest')).toBe(false);
    expect(installedByName('         ufw-extra \\\n', 'ufw')).toBe(false);
    expect(installedByName('         ufw \\\n', 'ufw')).toBe(true);
  });

  // WI-10005830: the base keeps /usr/local inside the read-only /usr, so every runtime install the
  // bootstrap makes there died with EROFS on a booted host. The image links it to machine-local
  // storage, and the bootstrap's validate-host asserts the link against the SAME constant.
  it('links /usr/local to the machine-local root the bootstrap asserts, and refuses to drop image content doing it', () => {
    const link = containerfile.indexOf('ln -s ../var/usrlocal /usr/local');
    expect(link, 'workspace-host.Containerfile no longer links /usr/local').toBeGreaterThan(-1);
    // The relative link resolves from /usr, exactly as readlink -f does on the host.
    expect(join('/usr', '../var/usrlocal')).toBe(WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET);
    const guard = containerfile.indexOf('find /usr/local -mindepth 1 -not -type d -print -quit');
    expect(guard, 'the link no longer refuses a /usr/local that carries files').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(link);
    expect(link).toBeLessThan(containerfile.indexOf('RUN bootc container lint'));
  });

  it('ships the tmpfiles dropin that creates the /usr/local subdirectories the bootstrap installs into', () => {
    const dropIn = join(BOOTC_DIR, 'papercusp-usrlocal.tmpfiles.conf');
    expect(existsSync(dropIn)).toBe(true);
    const body = readFileSync(dropIn, 'utf8');
    for (const sub of ['bin', 'sbin', 'lib', 'libexec']) {
      expect(body).toMatch(new RegExp(`^d ${WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET}/${sub} 0755 root root -$`, 'm'));
    }
    expect(containerfile).toMatch(
      /^COPY papercusp-usrlocal\.tmpfiles\.conf \/usr\/lib\/tmpfiles\.d\/papercusp-usrlocal\.conf$/m,
    );
  });

  it('google-guest-agent is installed but skipped off GCE, like amazon-ssm-agent off EC2', () => {
    const dropIn = join(BOOTC_DIR, 'papercusp-google-guest-agent-gce-only.conf');
    expect(existsSync(dropIn)).toBe(true);
    expect(readFileSync(dropIn, 'utf8')).toMatch(/^\[Unit\]\nConditionFirmware=smbios-field\(sys_vendor = "Google"\)$/m);
    expect(containerfile).toMatch(
      /^COPY papercusp-google-guest-agent-gce-only\.conf \/usr\/lib\/systemd\/system\/google-guest-agent\.service\.d\/papercusp-gce-only\.conf$/m,
    );
  });
});

/**
 * The Ubuntu host model installs WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES at boot; the bootc model
 * must carry an RPM for every one of them in the image instead. WI-10005779: `git` was missing
 * from BOTH lists (stock Ubuntu ships it), so the bootc image booted without it and the content
 * bootstrap died with `spawn git ENOENT`. A new apt name with no row here fails the first test.
 */
const APT_TO_BOOTC_RPM: Readonly<Record<string, string>> = {
  acl: 'acl',
  bubblewrap: 'bubblewrap',
  'ca-certificates': 'ca-certificates',
  curl: 'curl',
  git: 'git-core',
  jq: 'jq',
  minisign: 'minisign',
  'openssh-server': 'openssh-server',
  sudo: 'sudo',
  // Behavioural substitutions (RPM-EQUIVALENCE.md §G), not renames.
  ufw: 'nftables',
  'unattended-upgrades': 'dnf-automatic',
  // Native SONAME providers, re-derived per RPM-EQUIVALENCE.md §D.
  libasound2t64: 'alsa-lib',
  libatomic1: 'libatomic',
  'libgcc-s1': 'libgcc',
  'liblz4-1': 'lz4-libs',
  libssl3: 'openssl-libs',
  'libstdc++6': 'libstdc++',
  libzstd1: 'libzstd',
  // EL10 (centos-bootc:stream10, D-035 / WI-10005910) provides libz.so.1 from zlib-ng in
  // compat mode; the EL9 package name `zlib` no longer exists there.
  zlib1g: 'zlib-ng-compat',
};

describe('bootc image carries the apt host contract (WI-10005779)', () => {
  // Strip the inline `# ...` backtick comments so a package named only inside a comment does
  // not count, and so a package line with a trailing comment still matches.
  const executable = readFileSync(CONTAINERFILE, 'utf8').replace(/`#[^`]*`/g, '');

  it('every apt contract package has a bootc RPM row, and no row is stale', () => {
    const apt = [...WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES] as string[];
    for (const pkg of apt) expect(APT_TO_BOOTC_RPM, `no bootc RPM row for apt package ${pkg}`).toHaveProperty(pkg);
    for (const pkg of Object.keys(APT_TO_BOOTC_RPM)) expect(apt, `stale row ${pkg}`).toContain(pkg);
  });

  it('the bootc image installs the RPM for every apt contract package', () => {
    for (const [apt, rpm] of Object.entries(APT_TO_BOOTC_RPM)) {
      expect(installedByName(executable, rpm), `${apt} -> ${rpm} is not installed by workspace-host.Containerfile`).toBe(true);
    }
  });

  it('the content bootstrap clones with git, so both host models must provide git', () => {
    const installer = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'cupboard', 'offline-content-bundle-install-io.ts'),
      'utf8',
    );
    // Positive control: the installer really spawns git. If it stops, drop git from both lists.
    expect(installer).toMatch(/spawn\('git', \['clone'/);
    expect(WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES as readonly string[]).toContain('git');
    expect(installedByName(executable, 'git-core')).toBe(true);
    // The build fails on a missing package rather than shipping an image without it.
    expect(executable).toMatch(/rpm -q [^\n]*\bgit-core\b/);
  });

  it('a package named only inside a comment does not count as installed', () => {
    expect(installedByName('         `# git-core is great` \\\n'.replace(/`#[^`]*`/g, ''), 'git-core')).toBe(false);
  });
});

describe('bootc Google guest repo matches the base and its signing key (WI-10005910)', () => {
  const containerfile = readFileSync(CONTAINERFILE, 'utf8');
  const base = /^FROM quay\.io\/centos-bootc\/centos-bootc:stream(\d+) AS workspace-host-os$/m.exec(containerfile);
  const repo = /'baseurl=https:\/\/packages\.cloud\.google\.com\/yum\/repos\/google-compute-engine-el(\d+)-x86_64-stable'/.exec(
    containerfile,
  );
  const gpgkey = /'gpgkey=([^']*)'/.exec(containerfile);

  it('installs the Google repo for the same EL major as the bootc base', () => {
    expect(base, 'FROM centos-bootc:streamN not found').not.toBeNull();
    expect(repo, 'google-compute-engine-elN baseurl not found').not.toBeNull();
    expect(repo![1]).toBe(base![1]);
  });

  it('verifies an EL10+ Google repo with the v10 key, not the SHA-1-bound legacy keys', () => {
    // EL10's rpm (sequoia) refuses rpm-package-key.gpg: its only binding signature is SHA-1, so
    // chain4's build died at "Key import failed (code 3)" on google-guest-agent. Measured: the v10
    // key installs google-guest-agent, google-compute-engine and -oslogin with gpgcheck=1.
    expect(gpgkey, 'gpgkey= not found').not.toBeNull();
    const keys = gpgkey![1].split(/\s+/).filter(Boolean);
    if (Number(repo?.[1] ?? 0) >= 10) {
      expect(keys).toEqual(['https://packages.cloud.google.com/yum/doc/rpm-package-key-v10.gpg']);
    }
    expect(containerfile).toMatch(/^\s+'gpgcheck=1' \\$/m);
  });
});

describe('bootc OS Login RPM scriptlet contract (WI-10005926)', () => {
  const containerfile = readFileSync(CONTAINERFILE, 'utf8');
  const executable = containerfile.replace(/`#[^`]*`/g, '');

  it('keeps OS Login scriptlets enabled while suppressing only google-compute-engine %post', () => {
    const googleRepo = executable.indexOf('--enablerepo=google-compute-engine');
    const installStart = executable.lastIndexOf('dnf -y install', googleRepo);
    const installEnd = executable.indexOf('&& dnf -y install', installStart);
    expect(googleRepo).toBeGreaterThan(-1);
    expect(installStart).toBeGreaterThan(-1);
    expect(installEnd).toBeGreaterThan(installStart);

    const scriptletEnabledInstall = executable.slice(installStart, installEnd);
    expect(scriptletEnabledInstall).toContain('google-compute-engine-oslogin');
    expect(scriptletEnabledInstall).not.toContain('tsflags=noscripts');

    const scriptletSuppressedInstall = executable.slice(installEnd, executable.indexOf('&& curl', installEnd));
    expect(scriptletSuppressedInstall).toContain('--setopt=tsflags=noscripts');
    expect(scriptletSuppressedInstall).toContain('google-compute-engine');
    expect(scriptletSuppressedInstall).not.toContain('google-compute-engine-oslogin');
    expect(containerfile).toContain('systemctl enable google-guest-agent.service google-oslogin-cache.timer');
  });
});

describe('bootc base package freshness (WI-10005681)', () => {
  const containerfile = readFileSync(CONTAINERFILE, 'utf8');
  // Drop the inline `# ...` backtick comments so a comment that merely MENTIONS the command
  // cannot satisfy the guard.
  const executable = containerfile.replace(/`#[^`]*`/g, '');

  it('upgrades the base image packages before the first package install', () => {
    // `dnf install` never upgrades a package the base already carries, so without an upgrade the
    // image ships whatever the base digest pinned (102 fixed high/critical on the P-012 AWS bake).
    const upgrade = executable.search(/\bdnf -y upgrade --refresh\b/);
    const firstListInstall = executable.search(/\bdnf -y install --setopt=install_weak_deps=False \\\s*\n\s*--enablerepo=google-compute-engine/);
    expect(upgrade, 'workspace-host.Containerfile never runs `dnf -y upgrade --refresh`').toBeGreaterThanOrEqual(0);
    expect(firstListInstall, 'the main package install block was not found').toBeGreaterThanOrEqual(0);
    expect(upgrade).toBeLessThan(firstListInstall);
  });
});
