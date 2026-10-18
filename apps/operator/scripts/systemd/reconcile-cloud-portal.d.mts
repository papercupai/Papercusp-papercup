export interface PortalReconcileConfig {
  portalRoot: string;
  runtimeRoot: string;
  integrationRoot: string;
  deployScript: string;
  npm: string;
  port: number;
  publicLinksEnv?: string;
  env: Record<string, string>;
}

/** Load the same validated public configuration used by Portal reconciliation. */
export function publicLinksSnapshot(
  path: string,
  inherited: Record<string, string | undefined>,
  options?: { required?: string[] },
): Promise<{
  env: Record<string, string | undefined>;
  links: Record<string, string>;
  digest: string;
}>;

export function reconcilePortal(
  config: PortalReconcileConfig,
  deps?: object,
): Promise<{ status: 'fresh' | 'recovered' | 'deployed'; releasePath: string }>;

/** Report the reconcile outcome on stdout/stderr and exit the one-shot process (0 ok, 1 failed). */
export function settleReconcileProcess(
  task: Promise<{ status: string; releasePath: string }>,
): Promise<never>;
