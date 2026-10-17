/** Deterministic plan-schedulable hosted billing reconciliation (P-016). */
import { escalateAlarm } from '../../alarm-attention';
import { getFlag } from '@papercusp/flags/server';
import { PostgresHostedBillingStore } from '../../auth/hosted/billing/billing-store';
import { createConfiguredHostedSubscriptionEntitlementProvider } from '../../auth/hosted/billing/entitlement-seam';
import { reconcileHostedBilling, type HostedBillingFailureObservation, type HostedBillingRecoveryInput, type HostedBillingRecoveryDependencies } from '../../auth/hosted/billing/billing-recovery';
import { resolveHostedBillingStripe, readHostedBillingRuntimeConfiguration } from '../../endpoint-route/hosted-billing-runtime';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const HOSTED_BILLING_RECONCILE = 'hosted-billing-reconcile';

const safeFailureAlert = async ({ failureClass, eventId }: HostedBillingFailureObservation): Promise<void> => {
  const conditionKey = `alarm:hosted-billing:${failureClass}`;
  await escalateAlarm({
    title: `Hosted billing ${failureClass}`,
    body: `A hosted billing delivery/recovery issue was observed (${failureClass})${eventId ? `; event ${eventId}` : ''}. Inspect the bounded billing ledger and provider evidence.`,
    cooldownMs: 6 * 60 * 60 * 1000,
    source: HOSTED_BILLING_RECONCILE,
    conditionKey,
    data: { failureClass, ...(eventId ? { eventId } : {}) },
  });
};

export interface HostedBillingReconcileActionDeps {
  readonly run?: typeof reconcileHostedBilling;
  readonly makeDeps?: (ctx: SystemActionCtx, input: HostedBillingRecoveryInput) => Promise<HostedBillingRecoveryDependencies>;
  readonly now?: () => number;
}

export function makeHostedBillingReconcileAction(overrides: HostedBillingReconcileActionDeps = {}) {
  return async (ctx: SystemActionCtx): Promise<SystemActionResult> => {
    const payload = (ctx.payloadTemplate ?? {}) as { input?: Record<string, unknown> };
    const nowSeconds = Math.floor((overrides.now ?? Date.now)() / 1000);
    const input = { accountId: typeof payload.input?.accountId === 'string' ? payload.input.accountId : '',
      createdFrom: typeof payload.input?.createdFrom === 'number' ? payload.input.createdFrom : Math.max(0, nowSeconds - 86_460),
      createdBefore: typeof payload.input?.createdBefore === 'number' ? payload.input.createdBefore : nowSeconds - 60,
      overlapSeconds: typeof payload.input?.overlapSeconds === 'number' ? payload.input.overlapSeconds : 300,
      maxCustomers: typeof payload.input?.maxCustomers === 'number' ? payload.input.maxCustomers : 20,
      maxPages: typeof payload.input?.maxPages === 'number' ? payload.input.maxPages : 3 } satisfies HostedBillingRecoveryInput;
    if (!input.accountId) throw new Error('hosted_billing_reconcile_account_required');
    const deps = overrides.makeDeps ? await overrides.makeDeps(ctx, input) : await productionDeps(input, ctx.workspaceId);
    const out = await (overrides.run ?? reconcileHostedBilling)(input, deps, AbortSignal.timeout(30_000));
    return { diagnostics: { hostedBillingReconcile: out },
      ...(out.failed || out.budgetExhausted || out.issues.length ? {
        softError: `hosted billing recovery: failures=${out.failed}, unfinished=${out.budgetExhausted}, deliveryIssues=${out.issues.length}`,
      } : {}) };
  };
}

export function assertHostedBillingRecoveryRuntime(env: NodeJS.ProcessEnv, accountId: string): void {
  if (env.PAPERCUSP_DEPLOYMENT_ENVIRONMENT !== 'production'
      || env.PAPERCUSP_DISTRIBUTION_PROFILE !== 'hosted-control-plane'
      || !/^acct_[A-Za-z0-9]+$/.test(accountId) || env.PAPERCUSP_STRIPE_ACCOUNT_ID !== accountId) {
    throw new Error('hosted_billing_reconcile_runtime_contract_unavailable');
  }
}

async function productionDeps(input: HostedBillingRecoveryInput, workspaceId: string): Promise<HostedBillingRecoveryDependencies> {
  assertHostedBillingRecoveryRuntime(process.env, input.accountId);
  const configuration = readHostedBillingRuntimeConfiguration(process.env);
  const resolved = await resolveHostedBillingStripe(configuration, {
    liveModeAllowed: () => getFlag('papercusp-hosted-billing-live-mode', workspaceId),
  });
  if (!resolved.stripe) throw new Error(`hosted_billing_reconcile_unavailable:${resolved.reason ?? 'unknown'}`);
  if (!resolved.stripe.client.livemode) throw new Error('hosted_billing_reconcile_production_mode_required');
  const store = new PostgresHostedBillingStore(undefined, configuration.plans.some(plan => plan.entitlementBundle)
    ? createConfiguredHostedSubscriptionEntitlementProvider(configuration.plans) : undefined);
  const planKeyForPrice = (priceId: string | null): string | null =>
    configuration.plans.find(plan => plan.priceId === priceId)?.planKey ?? null;
  return { store, client: resolved.stripe.client, planKeyForPrice, observe: safeFailureAlert };
}

registerSystemAction(HOSTED_BILLING_RECONCILE, makeHostedBillingReconcileAction(), {
  scheduling: 'on-demand', planSchedulable: true,
  routineTimeoutMs: 90_000,
});
