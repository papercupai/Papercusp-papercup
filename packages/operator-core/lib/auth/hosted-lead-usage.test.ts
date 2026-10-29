import { describe, expect, it, vi } from 'vitest';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { HostedLeadUsageService } from './hosted-lead-usage';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '../telemetry-kinds';
import { cloudTelemetryIdentity, cloudTelemetrySubjectIdentity } from '../cloud-telemetry';
import { createHostedPrincipal } from './hosted-principal';
import type { enforceExactServiceAppKeyScope } from '../connected-apps/enforce';

const input = { personRef: 'PER-a', windowStart: '2026-10-15T00:00:00Z', windowEnd: '2026-10-27T00:00:00Z' };
const request = { toolName: 'people:usage', capabilities: [], boundary: 'http', args: input,
  ctx: { workspaceId: 'graph', principal: { kind: 'service', trust: 'verified', authMethod: 'bearer-token',
    slug: 'app:crm/token', workspaceId: 'graph' } } } as unknown as KernelEnforcementRequest;
const subject = () => ({ receipt: { ref: 'hosted-lead-binding:receipt', graphWorkspaceId: 'graph',
  personRef: 'PER-a', environment: 'production' as const, userId: 'hosted-user', organizationId: 'hosted-org',
  redeemedAt: '2026-10-14T00:00:00Z' }, consent: { ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
    analytics: { enabled: true, since: '2026-10-15T00:00:00Z' } } });
function fixture() {
  const checkGrant = vi.fn<typeof enforceExactServiceAppKeyScope>(async () => null);
  const readSubject = vi.fn(async () => subject());
  const readUsage = vi.fn(async (args: { readConsent: () => Promise<unknown> }) => {
    await args.readConsent(); await args.readConsent();
    return { status: 'observed' as const, windowStart: input.windowStart, windowEnd: input.windowEnd,
      evidenceRef: 'posthog:1:hogql:proof', observations: 1, portalSessionObservations: 1,
      readyProvisioningObservations: 0, featureAdoptionObservations: 0 };
  });
  const service = new HostedLeadUsageService({ graphWorkspaceId: 'graph', environment: 'production' },
    { checkGrant, readSubject, readUsage });
  return { service, checkGrant, readSubject, readUsage };
}
describe('D053 background usage authority', () => {
  it('refuses an explicit grant denial before accessing the subject', async () => {
    const f = fixture();
    f.checkGrant.mockResolvedValueOnce({ decision: 'deny', availability: 'available', applied: true,
      code: 'app_scope:exact_tool_grant_required', reason: 'Exact tool grant required' });
    expect((await f.service.read(input, request)).status).toBe('unknown');
    expect(f.readSubject).not.toHaveBeenCalled(); expect(f.readUsage).not.toHaveBeenCalled();
  });
  it('checks exact grant and canonical storage subject at every consent boundary and final return', async () => {
    const f = fixture();
    const result = await f.service.read(input, request);
    expect(result.status).toBe('observed');
    expect(f.checkGrant).toHaveBeenCalledTimes(4);
    expect(f.readSubject).toHaveBeenCalledTimes(4);
    expect(f.readSubject).toHaveBeenCalledWith({ graphWorkspaceId: 'graph', personRef: 'PER-a', environment: 'production' });
    expect(f.readUsage).toHaveBeenCalledWith(expect.objectContaining({ subject: { userId: 'hosted-user', organizationId: 'hosted-org' } }));
    expect(result).toMatchObject({ bindingRef: 'hosted-lead-binding:receipt' });
    expect(JSON.stringify(result)).not.toMatch(/hosted-user|hosted-org/);
  });
  it.each(['userId', 'organizationId', 'consent', 'distinctId', 'environment', 'graphWorkspaceId'])('rejects caller selector %s', async key => {
    const f = fixture();
    expect(await f.service.read({ ...input, [key]: 'injected' }, request)).toMatchObject({ status: 'unknown', reason: 'invalid_request' });
    expect(f.checkGrant).not.toHaveBeenCalled(); expect(f.readUsage).not.toHaveBeenCalled();
  });
  it.each(['workspace', 'principal-workspace', 'tool'])('refuses wrong %s before subject or vendor read', async kind => {
    const f = fixture();
    const changed = { ...request, ctx: { ...request.ctx, principal: { ...request.ctx.principal! } } };
    if (kind === 'workspace') changed.ctx.workspaceId = 'other';
    if (kind === 'principal-workspace') changed.ctx.principal.workspaceId = 'other';
    if (kind === 'tool') changed.toolName = 'people:get';
    expect((await f.service.read(input, changed)).status).toBe('unknown');
    expect(f.readSubject).not.toHaveBeenCalled(); expect(f.readUsage).not.toHaveBeenCalled();
  });
  it.each(['grant', 'receipt', 'identity', 'epoch', 'consent'])('discards vendor result when %s changes during read', async kind => {
    const f = fixture();
    f.readUsage.mockImplementationOnce(async () => {
      if (kind === 'grant') f.checkGrant.mockRejectedValueOnce(new Error('revoked'));
      else {
        const changed = subject();
        if (kind === 'receipt') changed.receipt.ref = 'replacement';
        if (kind === 'identity') changed.receipt.userId = 'replacement';
        if (kind === 'epoch') changed.consent.analytics.since = '2026-10-16T00:00:00Z';
        if (kind === 'consent') changed.consent.analytics.enabled = false;
        f.readSubject.mockResolvedValueOnce(changed);
      }
      return { status: 'observed', windowStart: input.windowStart, windowEnd: input.windowEnd,
        evidenceRef: 'private-result', observations: 1, portalSessionObservations: 1,
        readyProvisioningObservations: 0, featureAdoptionObservations: 0 };
    });
    expect(await f.service.read(input, request)).toEqual({ status: 'unknown', reason: 'authority_unavailable' });
  });
  it('uses the capture writer identity without creating a hosted session', () => {
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'hosted-org',
      userId: 'hosted-user', sessionId: 'cookie', sessionVersion: 1, permissions: [] });
    const identity = cloudTelemetrySubjectIdentity({ userId: 'hosted-user', organizationId: 'hosted-org' }, 'production');
    expect(identity).toEqual(cloudTelemetryIdentity({ principal, environment: 'production' }));
    expect(JSON.stringify(identity)).not.toMatch(/hosted-user|hosted-org|cookie/);
  });
});
