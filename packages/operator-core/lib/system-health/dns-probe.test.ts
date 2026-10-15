/** WI-6554700010008585: the DNS canary probe that feeds the dns-resolution-failing liveness signal. */
import { describe, expect, it } from 'vitest';
import { DNS_CANARY_NAMES, probeDnsResolution, type DnsResolveFn } from './dns-probe';

const NAMES = ['a.example', 'b.example', 'c.example'];
const err = (code: string) => Object.assign(new Error(code), { code });

describe('probeDnsResolution', () => {
  it('reports ok when every canary resolves', async () => {
    const resolve: DnsResolveFn = async () => ['192.0.2.1'];
    const r = await probeDnsResolution({ names: NAMES, resolve });
    expect(r.ok).toBe(true);
    expect(r.allFailed).toBe(false);
    expect(r.names.map((n) => n.ok)).toEqual([true, true, true]);
    expect(r.names.every((n) => n.error === undefined)).toBe(true);
  });

  it('reports allFailed with each error code when the resolver rejects everything (DNSSEC missing-key → SERVFAIL)', async () => {
    const resolve: DnsResolveFn = async () => {
      throw err('ESERVFAIL');
    };
    const r = await probeDnsResolution({ names: NAMES, resolve });
    expect(r.ok).toBe(false);
    expect(r.allFailed).toBe(true);
    expect(r.names.map((n) => n.error)).toEqual(['ESERVFAIL', 'ESERVFAIL', 'ESERVFAIL']);
  });

  it('a partial failure is neither ok nor allFailed', async () => {
    const resolve: DnsResolveFn = async (name) => {
      if (name === 'b.example') throw err('ENOTFOUND');
      return ['192.0.2.1'];
    };
    const r = await probeDnsResolution({ names: NAMES, resolve });
    expect(r.ok).toBe(false);
    expect(r.allFailed).toBe(false);
    expect(r.names.find((n) => n.name === 'b.example')?.error).toBe('ENOTFOUND');
  });

  it('bounds a hung resolver with its own timeout instead of hanging the health tick', async () => {
    const resolve: DnsResolveFn = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await probeDnsResolution({ names: NAMES, resolve, timeoutMs: 20 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.allFailed).toBe(true);
    expect(r.names.map((n) => n.error)).toEqual(['timeout', 'timeout', 'timeout']);
  });

  it('treats an empty answer as a failure, not a resolution', async () => {
    const resolve: DnsResolveFn = async () => [];
    const r = await probeDnsResolution({ names: ['a.example'], resolve });
    expect(r.allFailed).toBe(true);
    expect(r.names[0]?.error).toBe('ENODATA');
  });

  it('never throws, even when the resolver throws synchronously', async () => {
    const resolve: DnsResolveFn = () => {
      throw new Error('boom');
    };
    const r = await probeDnsResolution({ names: ['a.example'], resolve });
    expect(r.allFailed).toBe(true);
    expect(r.names[0]?.error).toBe('boom');
  });

  it('canaries are the hosts the fleet depends on', () => {
    expect(DNS_CANARY_NAMES).toEqual(expect.arrayContaining(['registry-1.docker.io', 'api.github.com', 'api.openai.com']));
  });
});
