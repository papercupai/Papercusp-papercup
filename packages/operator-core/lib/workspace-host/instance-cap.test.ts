import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_HOSTED_CONNECTION_INSTANCE_CAP,
  WORKSPACE_HOST_INSTANCE_CAP_ERROR,
  decideWorkspaceHostInstanceCap,
  workspaceHostConnectionInstanceCap,
} from './instance-cap';

const ref = (value: string) => ({ cloudCredentialRef: { kind: 'cloud' as const, ref: value } });

describe('workspaceHostConnectionInstanceCap', () => {
  it('caps every hosted-control-plane connection at one live host, on any cloud', () => {
    for (const hosted of ['delegation://ws/conn-1', 'encrypted://k/1', 'resolver://aws']) {
      expect(workspaceHostConnectionInstanceCap(ref(hosted))).toBe(WORKSPACE_HOST_HOSTED_CONNECTION_INSTANCE_CAP);
    }
    expect(WORKSPACE_HOST_HOSTED_CONNECTION_INSTANCE_CAP).toBe(1);
  });

  it('leaves the operator’s own credentials (desktop BYOC) uncapped', () => {
    for (const local of ['aws-profile://papercusp-byoc', 'adc://controller', 'gcp-sa://key']) {
      expect(workspaceHostConnectionInstanceCap(ref(local))).toBeNull();
    }
  });
});

describe('decideWorkspaceHostInstanceCap', () => {
  it('refuses a second live host with the named cap error and names the occupying host', () => {
    expect(decideWorkspaceHostInstanceCap({ cap: 1, requestedHostId: 'host-2', liveHostIds: ['host-1'] })).toEqual({
      admitted: false,
      error: WORKSPACE_HOST_INSTANCE_CAP_ERROR,
      cap: 1,
      liveHostIds: ['host-1'],
    });
    expect(WORKSPACE_HOST_INSTANCE_CAP_ERROR).toBe('workspace_host_instance_cap_exceeded');
  });

  it('admits the first host and a resume of the host that is already live', () => {
    expect(decideWorkspaceHostInstanceCap({ cap: 1, requestedHostId: 'host-1', liveHostIds: [] }).admitted).toBe(true);
    expect(decideWorkspaceHostInstanceCap({ cap: 1, requestedHostId: 'host-1', liveHostIds: ['host-1'] }).admitted).toBe(
      true,
    );
  });

  it('never lets duplicate census rows make room, and admits anything when uncapped', () => {
    expect(
      decideWorkspaceHostInstanceCap({ cap: 2, requestedHostId: 'host-3', liveHostIds: ['host-1', 'host-1'] }).admitted,
    ).toBe(true);
    expect(
      decideWorkspaceHostInstanceCap({ cap: 2, requestedHostId: 'host-3', liveHostIds: ['host-1', 'host-2'] }).admitted,
    ).toBe(false);
    expect(decideWorkspaceHostInstanceCap({ cap: null, requestedHostId: 'h', liveHostIds: ['a', 'b', 'c'] })).toEqual({
      admitted: true,
      cap: null,
    });
  });

  it('rejects a non-positive cap rather than silently admitting or refusing everything', () => {
    expect(() => decideWorkspaceHostInstanceCap({ cap: 0, requestedHostId: 'h', liveHostIds: [] })).toThrow(/positive integer/);
  });
});
