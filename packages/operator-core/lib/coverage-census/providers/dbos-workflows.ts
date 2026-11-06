/** Runtime discovery through the SDK's public launch middleware. This is an
 * observed registration set, never proof of source/adapter population closure. */
import type { DBOS } from '@dbos-inc/dbos-sdk';
import type { ObservedSurface } from '@papercusp/testing-shell/census';
import { pinModuleState } from '@papercusp/module-singleton';
import { loadedHandlerFingerprint } from '../../observability/runtime';

type Sdk = Pick<typeof DBOS, 'registerMiddlewareInstaller'>;
type Installer = Parameters<Sdk['registerMiddlewareInstaller']>[0];
type Method = Parameters<Installer['installMiddleware']>[0];

export function createDbosSecurityObserver() {
  const installed = new WeakSet<Sdk>();
  const methods = new Map<Method, ObservedSurface>();
  return {
    install(sdk: Sdk) {
      if (installed.has(sdk)) return;
      sdk.registerMiddlewareInstaller({ installMiddleware(method) {
        // Copy only names, types and loaded code digests. No arguments, results,
        // credentials, function bodies or arbitrary workflow configuration.
        const kind = method.workflowConfig ? 'dbos-workflow' : method.stepConfig ? 'dbos-step' : 'dbos-method';
        methods.set(method, { kind, surfaceId: JSON.stringify([method.className, method.name]),
          sourceFile: null, fidelity: 'observed', attrs: {
            className: method.className, name: method.name,
            loadedFunctionSha256: loadedHandlerFingerprint(method.origFunction as (...args: never[]) => unknown),
            functionFingerprintScope: 'loaded-function-text-only',
            argumentCount: method.args.length, instance: method.isInstance,
          } });
      } });
      installed.add(sdk);
    },
    capture(launched: boolean) {
      const surfaces = [...methods.values()].map(row => ({ ...row, attrs: { ...row.attrs, executorLaunched: launched } }));
      const unresolved = ['dbos-registration-source-and-adapter-reconciliation-unverified'];
      if (!launched) unresolved.push('dbos-executor-not-launched');
      if (!surfaces.length) unresolved.push('dbos-installed-registration-set-empty');
      const seen = new Set<string>();
      for (const row of surfaces) {
        const key = JSON.stringify([row.kind, row.surfaceId]);
        if (seen.has(key)) unresolved.push('dbos-installed-registration-duplicate:' + key);
        seen.add(key);
        if (!row.attrs.loadedFunctionSha256) unresolved.push('dbos-loaded-function-unavailable:' + key);
      }
      return { surfaces, unresolved, closureAccepted: false as const };
    },
  };
}

export const dbosSecurityObserver = pinModuleState('@papercusp/operator-core.dbos-security-discovery',
  createDbosSecurityObserver);
