import { describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceHostSoakSeams } from './soak-seams';

function lookupFor(target: string | null) {
  return target === null
    ? { desired: null, miss: 'no-recorded-spec' }
    : { desired: { hostId: 'host-1', target }, connectionId: 'connection-1' };
}

async function dispatch(target: string | null) {
  const lookup = lookupFor(target);
  const readDesiredSpec = vi.fn(async () => lookup);
  const resolveAws = vi.fn(async (_input: unknown) => ({ cloud: 'aws' }));
  const resolveGcp = vi.fn(async (_input: unknown) => ({ cloud: 'gcp' }));
  const result = resolveWorkspaceHostSoakSeams({
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    readDesiredSpec: readDesiredSpec as never,
    resolveAws: resolveAws as never,
    resolveGcp: resolveGcp as never,
  });
  return { result, lookup, readDesiredSpec, resolveAws, resolveGcp };
}

describe('workspace-host soak seam dispatch (P-007)', () => {
  it('routes an AWS host to the AWS seams, handing over the same spec row it decided on', async () => {
    const { result, lookup, readDesiredSpec, resolveAws, resolveGcp } = await dispatch('aws');

    expect(await result).toEqual({ cloud: 'aws' });
    expect(resolveGcp).not.toHaveBeenCalled();
    expect(readDesiredSpec).toHaveBeenCalledOnce();
    const handed = resolveAws.mock.calls[0]?.[0] as { readDesiredSpec(): Promise<unknown>; hostId: string };
    expect(handed.hostId).toBe('host-1');
    expect(await handed.readDesiredSpec()).toBe(lookup);
  });

  it('routes a GCP host to the GCP seams', async () => {
    const { result, resolveAws, resolveGcp } = await dispatch('gcp');

    expect(await result).toEqual({ cloud: 'gcp' });
    expect(resolveGcp).toHaveBeenCalledOnce();
    expect(resolveAws).not.toHaveBeenCalled();
  });

  it('lets the GCP resolver raise the canonical unavailable error for a host with no spec', async () => {
    const { result, resolveGcp } = await dispatch(null);

    await result;
    expect(resolveGcp).toHaveBeenCalledOnce();
  });

  it('refuses a cloud with no soak seams by name', async () => {
    const { result, resolveAws, resolveGcp } = await dispatch('azure');

    await expect(result).rejects.toThrow(/target 'azure'/);
    expect(resolveAws).not.toHaveBeenCalled();
    expect(resolveGcp).not.toHaveBeenCalled();
  });
});
