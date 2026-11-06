import { describe, expect, it } from 'vitest';
import type { DBOS } from '@dbos-inc/dbos-sdk';
import { createDbosSecurityObserver } from './dbos-workflows';

type Installer = Parameters<typeof DBOS.registerMiddlewareInstaller>[0];
type Method = Parameters<Installer['installMiddleware']>[0];
function fixture() {
  const installers: Installer[] = [];
  const sdk = { registerMiddlewareInstaller(installer: Installer) { installers.push(installer); } };
  const observer = createDbosSecurityObserver();
  observer.install(sdk);
  return { observer, sdk, installers, observe: (method: Method) => installers[0]!.installMiddleware(method) };
}
const method = (name: string, extra: Partial<Method> = {}): Method => ({
  name, className: '', args: [], isInstance: false, workflowConfig: {},
  origFunction: async function observedWorkflow() { throw Error('must never execute discovery'); },
  ...extra,
} as Method);

describe('SDK-installed DBOS security discovery', () => {
  it('keeps empty and unlaunched populations unresolved', () => {
    const { observer } = fixture();
    expect(observer.capture(false)).toMatchObject({ surfaces: [], closureAccepted: false,
      unresolved: expect.arrayContaining(['dbos-executor-not-launched', 'dbos-installed-registration-set-empty']) });
  });
  it('observes newly installed methods and code changes without executing or serializing payloads', () => {
    const { observer, observe } = fixture();
    const first = method('first', { workflowConfig: { secretPayload: 'private-canary' } as never });
    observe(first);
    const before = observer.capture(true);
    observe(method('second', { origFunction: async function changedWorkflow() { return 'private-canary'; } }));
    const after = observer.capture(true);
    expect(before.surfaces).toHaveLength(1);
    expect(after.surfaces).toHaveLength(2);
    expect(after.surfaces[0]!.attrs!.loadedFunctionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(after.surfaces[0]!.attrs!.loadedFunctionSha256).not.toBe(after.surfaces[1]!.attrs!.loadedFunctionSha256);
    expect(JSON.stringify(after)).not.toContain('private-canary');
    expect(after.unresolved).toContain('dbos-registration-source-and-adapter-reconciliation-unverified');
    expect(after.closureAccepted).toBe(false);
  });
  it('does not install twice or duplicate the same SDK method on a launch retry, but retains collisions', () => {
    const { observer, sdk, installers, observe } = fixture();
    observer.install(sdk);
    expect(installers).toHaveLength(1);
    const first = method('same');
    observe(first); observe(first);
    expect(observer.capture(true).surfaces).toHaveLength(1);
    observe(method('same'));
    const result = observer.capture(true);
    expect(result.surfaces).toHaveLength(2);
    expect(result.unresolved.some(row => row.startsWith('dbos-installed-registration-duplicate:'))).toBe(true);
  });
  it('distinguishes SDK steps from workflows and does not leak mutable capture rows back into the observer', () => {
    const { observer, observe } = fixture();
    observe(method('step', { workflowConfig: undefined, stepConfig: {} }));
    const capture = observer.capture(true);
    expect(capture.surfaces[0]!.kind).toBe('dbos-step');
    capture.surfaces[0]!.attrs!.name = 'tampered';
    expect(observer.capture(true).surfaces[0]!.attrs!.name).toBe('step');
  });
});
