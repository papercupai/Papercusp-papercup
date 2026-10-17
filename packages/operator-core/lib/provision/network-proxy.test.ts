import { describe, expect, it, vi } from 'vitest';
import { provisionConnectionPolicy } from './network-proxy';

describe('provision connection policy', () => {
  it.each(['169.254.169.254', '10.1.2.3', '172.16.1.1', '192.168.1.2', 'fc00::1',
    'fe80::1', '::ffff:10.1.2.3', '0.0.0.0', '2852039166', '0xa9fea9fe'])('denies assigned nonpublic address %s', async address => {
    const host = address.includes(':') ? `[${address}]` : address;
    await expect(provisionConnectionPolicy(address, 443, [`${host}:443`]))
      .rejects.toThrow(/denied address range/);
  });

  it('denies mixed public/private DNS answers before dialing', async () => {
    await expect(provisionConnectionPolicy('vendor.example', 443, ['vendor.example'], async () => [
      { address: '8.8.8.8', family: 4 }, { address: '10.1.2.3', family: 4 },
    ])).rejects.toThrow(/denied address range/);
  });

  it.each(['vendor.example/path', ' vendor.example:443', 'vendor.example:8443 ',
    'vendor.example\\', 'user@vendor.example'])('rejects malformed rule %s', async rule => {
    await expect(provisionConnectionPolicy('vendor.example', 443, [rule])).rejects.toThrow(/Invalid provision host rule/);
  });

  it('pins the validated dial address and never resolves again at connect time', async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const policy = await provisionConnectionPolicy('vendor.example', 443, ['vendor.example'], resolve);
    const lookup = policy.dnsLookup as unknown as (
      h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void,
    ) => void;
    const one = vi.fn();
    lookup('vendor.example', {}, one);
    expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const all = vi.fn();
    lookup('vendor.example', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('requires an exact loopback host and explicit port for self-talk', async () => {
    await expect(provisionConnectionPolicy('127.0.0.1', 32001, ['127.0.0.1:32001'])).resolves.toHaveProperty('dnsLookup');
    await expect(provisionConnectionPolicy('::1', 32001, ['[::1]:32001'])).resolves.toHaveProperty('dnsLookup');
    await expect(provisionConnectionPolicy('127.0.0.1', 443, ['127.0.0.1'])).rejects.toThrow(/denied/);
    await expect(provisionConnectionPolicy('127.0.0.1', 32002, ['127.0.0.1:32001'])).rejects.toThrow(/not allowlisted/);
    await expect(provisionConnectionPolicy('vendor.example', 443, ['vendor.example'],
      async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow(/denied/);
  });

  it('preserves fallback among validated public answers without another lookup', async () => {
    const addresses = [{ address: '8.8.8.8', family: 4 as const }, { address: '2606:4700:4700::1111', family: 6 as const }];
    const policy = await provisionConnectionPolicy('vendor.example', 443, ['vendor.example'], async () => addresses);
    const callback = vi.fn();
    policy.dnsLookup('vendor.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, addresses);
  });

  it('retains single-label versus explicit multi-label wildcards and HTTP port defaults', async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(provisionConnectionPolicy('api.vendor.example', 443, ['*.vendor.example'], resolve)).resolves.toHaveProperty('dnsLookup');
    await expect(provisionConnectionPolicy('deep.api.vendor.example', 443, ['*.vendor.example'], resolve)).rejects.toThrow(/not allowlisted/);
    await expect(provisionConnectionPolicy('deep.api.vendor.example', 443, ['**.vendor.example'], resolve)).resolves.toHaveProperty('dnsLookup');
    await expect(provisionConnectionPolicy('vendor.example', 8443, ['vendor.example'], resolve)).rejects.toThrow(/not allowlisted/);
    await expect(provisionConnectionPolicy('vendor.example', 443, [], resolve)).rejects.toThrow(/not allowlisted/);
    await expect(provisionConnectionPolicy('vendor.example', 443, ['vendor.example'], async () => [])).rejects.toThrow(/no addresses/);
  });
});
