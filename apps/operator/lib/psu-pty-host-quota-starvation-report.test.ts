/**
 * WI-6554700010011967: the pty host forwards its quota-block starvation verdict to
 * the operator, so the fleet leader hears it instead of waiting for presence decay.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { reportQuotaStarvation } from '../scripts/psu-pty-host.mjs';

const SIGNAL = { reason: 'quota-block-starvation', ageMs: 400000, attemptedGatedInjections: 2, agent: 'claude' };

describe('reportQuotaStarvation', () => {
  it('POSTs the signal, owner, workspace and account to the operator route', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const ok = await reportQuotaStarvation('su-a', SIGNAL, {
      env: { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170', PAPERCUSP_WORKSPACE: 'ws-1', PAPERCUSP_ACCOUNT_ID: 'acct-2' },
      fetchImpl: fetchImpl as never,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3170/api/admin/psu-pty/quota-starvation?workspace=ws-1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      ...SIGNAL,
      ownerId: 'su-a',
      workspace: 'ws-1',
      accountId: 'acct-2',
    });
  });

  it('defaults the operator URL and workspace, and sends a null account when unknown', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await reportQuotaStarvation('su-a', SIGNAL, { env: {}, fetchImpl: fetchImpl as never });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3270/api/admin/psu-pty/quota-starvation?workspace=default');
    expect(JSON.parse(String(init.body)).accountId).toBeNull();
  });

  it('resolves false, never rejects, when the operator is down or answers an error', async () => {
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(reportQuotaStarvation('su-a', SIGNAL, { env: {}, fetchImpl: down as never })).resolves.toBe(false);
    const err = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(reportQuotaStarvation('su-a', SIGNAL, { env: {}, fetchImpl: err as never })).resolves.toBe(false);
  });

  it('sends nothing without an owner id', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await expect(reportQuotaStarvation('  ', SIGNAL, { env: {}, fetchImpl: fetchImpl as never })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is called from the starvation guard callback, next to the host event', () => {
    const src = readFileSync(fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url)), 'utf8');
    const at = src.indexOf("appendHostEvent(ownerId, 'quota-block-starvation', extra);");
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 400);
    expect(after).toContain('void reportQuotaStarvation(ownerId, extra, { env });');
  });
});
