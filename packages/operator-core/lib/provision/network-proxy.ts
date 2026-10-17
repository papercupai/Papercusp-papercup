/** SRT's external HTTP/CONNECT proxy, using a maintained protocol implementation.
 * Validate every DNS answer and pin the actual dial: a preflight DNS check alone
 * would leave a second lookup free to resolve an approved name to private data.
 */
import { lookup } from 'node:dns/promises';
import type * as dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Server } from 'proxy-chain';
import { isNonPublicFetchAddress } from '../agent-tools/capability/fetch-policy';
import { buildNetworkPolicy, isHostAllowed } from './network-policy';

type Address = { address: string; family: 4 | 6 };
type Resolve = (host: string) => Promise<Address[]>;
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
const denyFloor = new BlockList();
for (const cidr of buildNetworkPolicy({}).deniedCidrs) {
  const [address, prefix] = cidr.split('/');
  denyFloor.addSubnet(address!, Number(prefix), isIP(address!) === 4 ? 'ipv4' : 'ipv6');
}

function canonicalHost(host: string): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return new URL(`http://${bracketed}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseRule(rule: string) {
  if (/[\s\\/?#@]/.test(rule)) throw new Error('Invalid provision host rule');
  const url = new URL(`http://${rule}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === '*') {
    throw new Error('Invalid provision host rule');
  }
  const explicitPort = /^(?:\[[^\]]+\]|[^:/?#]+):([0-9]+)$/.exec(rule)?.[1];
  return { host: canonicalHost(url.hostname), port: explicitPort ? Number(explicitPort) : undefined };
}

const resolveHost: Resolve = async host => {
  const family = isIP(host);
  if (family === 4 || family === 6) return [{ address: host, family }];
  return (await lookup(host, { all: true, verbatim: true })) as Address[];
};

/** Also used by the connection-level regression to distinguish validation from
 * pinning. The returned hook never performs another DNS lookup. */
export async function provisionConnectionPolicy(
  hostname: string, port: number, allowedHosts: readonly string[], resolve: Resolve = resolveHost,
): Promise<{ dnsLookup: typeof dns.lookup }> {
  const host = canonicalHost(hostname);
  const rules = allowedHosts.map(parseRule);
  const matching = rules.filter(rule => (rule.port === port ||
    (rule.port === undefined && (port === 80 || port === 443))) && isHostAllowed(host, [rule.host]));
  if (!matching.length) throw new Error('Provision destination is not allowlisted');
  const addresses = await resolve(host);
  if (!addresses.length) throw new Error('Provision destination has no addresses');
  const explicitSelfTalk = matching.some(rule => rule.port !== undefined && rule.host === host) &&
    addresses.every(a => loopback.check(a.address, a.family === 4 ? 'ipv4' : 'ipv6'));
  if (!explicitSelfTalk && addresses.some(a => isNonPublicFetchAddress(a.address) ||
    denyFloor.check(a.address, a.family === 4 ? 'ipv4' : 'ipv6'))) {
    throw new Error('Provision destination is in a denied address range');
  }
  const chosen = addresses[0]!;
  const pinnedLookup = ((
    _host: string, options: { all?: boolean },
    callback: (error: null, address: string | Address[], family?: number) => void,
  ) => {
    if (options.all) callback(null, addresses.map(address => ({ ...address })));
    else callback(null, chosen.address, chosen.family);
  }) as unknown as typeof dns.lookup;
  return { dnsLookup: pinnedLookup };
}

export async function startProvisionProxy(allowedHosts: readonly string[]) {
  // Reject malformed rules before opening a listener or launching a script.
  allowedHosts.forEach(parseRule);
  const server = new Server({
    host: '127.0.0.1', port: 0,
    prepareRequestFunction: ({ hostname, port }) => provisionConnectionPolicy(hostname, port, allowedHosts),
  });
  await server.listen();
  return { port: server.port, close: () => server.close(true) };
}
