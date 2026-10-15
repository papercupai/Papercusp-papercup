import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// @ts-expect-error -- side-effect-free .mjs sibling of the CLI binary; no type declarations.
import { buildCleanRoomInstanceCreateArgs } from '../../bin/gcp-clean-room-args.mjs';

/**
 * Regression guard for EI-21744781090863686.
 *
 * papercusp-gcp-clean-room.mjs declared `subnetwork` all the way down its input contract
 * (GcpImageFamilyCleanRoomRunInput.subnetwork -> request.cleanRoom.subnetwork -> spread into
 * adapter.launchCleanRoomCanary) and then never read it. The instance was created with no
 * `--subnet`, landing on the project's `default` network, which has no Cloud NAT and no
 * Private Google Access. Combined with `--no-address` that leaves the guest with zero
 * egress, while the fixture's bootstrap.sh must `apt-get install` and curl a ~273MB bundle
 * plus its detached signature from a public Cupboard URL.
 *
 * Nothing failed at the boundary: an entire declared field went unread, and the only place
 * it could surface was a real cloud boot timing out ~20 minutes in. These assertions make
 * dropping the field fail here instead.
 */
const baseInput = {
  instanceName: 'pc-cleanroom-abc123',
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  imageName: 'papercusp-workspace-host-0-0-18',
  imageProject: 'active-alcove-504205-q3',
  subnetwork: 'pc-p046-canary-02-a810e759-subnet',
  fixtureId: 'p046-gcp-canary',
};

describe('buildCleanRoomInstanceCreateArgs', () => {
  it('sizes the stock bootstrap disk to the maintained workspace-host image disk contract', () => {
    const template = readFileSync(new URL('../../../../infra/images/workspace-host.pkr.hcl', import.meta.url), 'utf8');
    const diskVariable = /variable "disk_size_gb"\s*\{([^}]+)\}/.exec(template)?.[1];
    const size = /default\s*=\s*(\d+)/.exec(diskVariable ?? '')?.[1];
    expect(size).toBeDefined();

    const args = buildCleanRoomInstanceCreateArgs({ ...baseInput, role: 'bootstrap-acceptance' });
    expect(args).toContain(`--boot-disk-size=${size}GB`);
    expect(args.filter((arg: string) => arg.startsWith('--boot-disk-size='))).toHaveLength(1);
    expect(args).toContain('--no-address');
    expect(args).toContain('--no-service-account');
    expect(args).toContain('--no-scopes');
  });

  it('lets post-build clean rooms inherit the candidate image disk size', () => {
    for (const role of [undefined, 'clean-room']) {
      const args = buildCleanRoomInstanceCreateArgs({ ...baseInput, ...(role ? { role } : {}) });
      expect(args.some((arg: string) => arg.startsWith('--boot-disk-size='))).toBe(false);
      expect(args).toContain(`--image=${baseInput.imageName}`);
    }
  });

  it('passes the caller-supplied subnetwork through as --subnet', () => {
    const args = buildCleanRoomInstanceCreateArgs(baseInput);
    expect(args).toContain('--subnet=pc-p046-canary-02-a810e759-subnet');
  });

  it('refuses to build args without a subnetwork rather than defaulting to a no-egress network', () => {
    for (const missing of [undefined, null, '', '   ']) {
      expect(() =>
        buildCleanRoomInstanceCreateArgs({ ...baseInput, subnetwork: missing }),
      ).toThrow(/subnetwork is required/i);
    }
  });

  it('keeps the no-public-ingress flags that the clean-room gate actually asserts', () => {
    // Cloud NAT restores EGRESS only. The canary's asserted property is
    // publicIpv4Assigned === false, so these must survive the subnet fix untouched.
    const args = buildCleanRoomInstanceCreateArgs(baseInput);
    expect(args).toContain('--no-address');
    expect(args).toContain('--no-service-account');
    expect(args).toContain('--no-scopes');
    expect(args.some((arg: string) => arg.startsWith('--address='))).toBe(false);
  });

  it('sanitises the fixture id into a legal GCP label value', () => {
    const args = buildCleanRoomInstanceCreateArgs({
      ...baseInput,
      fixtureId: 'P046/Canary With SPACES.and+punctuation',
    });
    const labels = args.find((arg: string) => arg.startsWith('--labels='));
    expect(labels).toBeDefined();
    const fixtureLabel = /papercusp-fixture=([^,]*)$/.exec(labels as string)?.[1] ?? '';
    expect(fixtureLabel).toMatch(/^[a-z0-9_-]*$/);
    expect(fixtureLabel.length).toBeLessThanOrEqual(63);
  });

  it('targets the requested image and project', () => {
    const args = buildCleanRoomInstanceCreateArgs(baseInput);
    expect(args).toContain('--image=papercusp-workspace-host-0-0-18');
    expect(args).toContain('--image-project=active-alcove-504205-q3');
    expect(args.slice(0, 4)).toEqual([
      'compute',
      'instances',
      'create',
      'pc-cleanroom-abc123',
    ]);
  });

  /**
   * Two different subjects share this argv — the post-build canary (boots the built image)
   * and the pre-build bootstrap-acceptance run (boots stock Ubuntu). They are otherwise
   * indistinguishable in the GCP console, which is exactly when the label matters: auditing
   * a leaked instance to find out which run failed to tear itself down.
   */
  it('labels the run with its role, defaulting to clean-room for the canary', () => {
    const labelsOf = (args: string[]): string =>
      args.find((arg: string) => arg.startsWith('--labels=')) ?? '';

    expect(labelsOf(buildCleanRoomInstanceCreateArgs(baseInput))).toContain(
      'papercusp-role=clean-room',
    );
    expect(
      labelsOf(buildCleanRoomInstanceCreateArgs({ ...baseInput, role: 'bootstrap-acceptance' })),
    ).toContain('papercusp-role=bootstrap-acceptance');
  });

  it('sanitizes a role into a legal GCP label value', () => {
    const args = buildCleanRoomInstanceCreateArgs({ ...baseInput, role: 'Bootstrap Acceptance!' });
    const labels = args.find((arg: string) => arg.startsWith('--labels=')) as string;
    const roleLabel = /papercusp-role=([^,]*)/.exec(labels)?.[1] ?? '';
    expect(roleLabel).toBe('bootstrap-acceptance-');
    expect(roleLabel).toMatch(/^[a-z0-9_-]*$/);
  });

  /**
   * --no-address is what makes the instance private, and the gate's whole subject is that
   * the host boots with no public INGRESS. A future edit that drops it would still pass
   * every other assertion here while silently voiding the property being certified.
   */
  it('keeps the instance private and unprivileged', () => {
    const args = buildCleanRoomInstanceCreateArgs(baseInput);
    expect(args).toContain('--no-address');
    expect(args).toContain('--no-service-account');
    expect(args).toContain('--no-scopes');
    expect(args).toContain('--metadata=enable-oslogin=TRUE');
  });
});
