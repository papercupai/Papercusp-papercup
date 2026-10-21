import { describe, expect, it } from 'vitest';
import { provisioningNotice } from './registration-provisioning';

// WI-6554700010018437: a failed schema scaffold must never render as a successful registration.
describe('provisioningNotice', () => {
  it('reports a failed provisioning with its error and the retry route', () => {
    const n = provisioningNotice({ provisioning: { ok: false, error: 'permission denied' } }, 'papercusp');
    expect(n?.kind).toBe('failed');
    expect(n?.message).toContain('permission denied');
    expect(n?.message).toContain('Submit the same folder again');
  });

  it('reports failure even when the route also says reprovisioned (a failed retry is still a failure)', () => {
    expect(provisioningNotice({ provisioning: { ok: false }, reprovisioned: true }, 'x')?.kind).toBe('failed');
  });

  it('reports a successful re-provision distinctly from a fresh registration', () => {
    expect(provisioningNotice({ provisioning: { ok: true }, reprovisioned: true }, 'x')?.kind).toBe('reprovisioned');
  });

  it('returns null for an ordinary successful registration (and for routes that omit provisioning)', () => {
    expect(provisioningNotice({ provisioning: { ok: true } }, 'x')).toBeNull();
    expect(provisioningNotice({}, 'x')).toBeNull();
  });
});
