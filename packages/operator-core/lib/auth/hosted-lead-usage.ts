/** D-053 background read. Transport authority stays separate from the hosted
 * subject. No user/org/consent/vendor selectors are accepted from tool JSON. */
import { z } from 'zod';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { enforceExactServiceAppKeyScope } from '../connected-apps/enforce';
import { readCloudProductUsageForSubject, type CloudProductUsageObservation } from '../cloud-telemetry-posthog';
import { PostgresHostedLeadBindingAuthority } from './hosted-lead-binding-authority';
import type { HostedLeadBindingScope } from './hosted-lead-binding';

export const hostedLeadUsageInputSchema = z.object({
  personRef: z.string().regex(/^PER-[A-Za-z0-9-]{1,160}$/),
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
}).strict().refine(value => Date.parse(value.windowStart) < Date.parse(value.windowEnd) &&
  Date.parse(value.windowEnd) - Date.parse(value.windowStart) <= 30 * 86_400_000);
type Subject = Awaited<ReturnType<PostgresHostedLeadBindingAuthority['readServiceSubject']>>;
export type HostedLeadUsageObservation = Extract<CloudProductUsageObservation, { status: 'unknown' }> |
  (Extract<CloudProductUsageObservation, { status: 'observed' }> & { bindingRef: string });

export class HostedLeadUsageService {
  constructor(private readonly config: {
    graphWorkspaceId: string; environment: HostedLeadBindingScope['environment'];
  }, private readonly dependencies: {
    checkGrant: typeof enforceExactServiceAppKeyScope;
    readSubject: (scope: HostedLeadBindingScope) => Promise<Subject>;
    readUsage: typeof readCloudProductUsageForSubject;
  } = {
    checkGrant: enforceExactServiceAppKeyScope,
    readSubject: scope => new PostgresHostedLeadBindingAuthority(config.graphWorkspaceId).readServiceSubject(scope),
    readUsage: readCloudProductUsageForSubject,
  }) {}

  /** request must be the dispatch seat's authenticated request, never body JSON. */
  async read(input: unknown, request: KernelEnforcementRequest): Promise<HostedLeadUsageObservation> {
    const parsed = hostedLeadUsageInputSchema.safeParse(input);
    if (!parsed.success) return { status: 'unknown', reason: 'invalid_request' };
    const scope = { graphWorkspaceId: this.config.graphWorkspaceId,
      environment: this.config.environment, personRef: parsed.data.personRef };
    const unavailable = (): HostedLeadUsageObservation => ({ status: 'unknown', reason: 'authority_unavailable' });
    const current = async () => {
      if (request.toolName !== 'people:usage' || request.ctx.workspaceId !== scope.graphWorkspaceId ||
          request.ctx.principal?.workspaceId !== scope.graphWorkspaceId ||
          await this.dependencies.checkGrant({ ...request, args: parsed.data })) return null;
      return this.dependencies.readSubject(scope);
    };
    try {
      const initial = await current();
      if (!initial) return unavailable();
      const recheck = async () => {
        const next = await current();
        if (!next || JSON.stringify(next.receipt) !== JSON.stringify(initial.receipt) ||
            !next.consent.analytics.enabled ||
            next.consent.analytics.since !== initial.consent.analytics.since) throw new Error('usage_authority_changed');
        return next.consent;
      };
      const result = await this.dependencies.readUsage({
        subject: { userId: initial.receipt.userId, organizationId: initial.receipt.organizationId },
        environment: scope.environment, windowStart: parsed.data.windowStart, windowEnd: parsed.data.windowEnd,
        readConsent: recheck,
      });
      await recheck();
      // Opaque proof reference only: hosted identity ids never leave the host.
      return result.status === 'observed' ? { ...result, bindingRef: initial.receipt.ref } : result;
    } catch { return unavailable(); }
  }
}
