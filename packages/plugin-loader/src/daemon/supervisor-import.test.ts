import { describe, expect, it, vi } from 'vitest';

const subprocess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => subprocess);

describe('daemon supervisor import isolation', () => {
  it('imports under a spawn-only subprocess mock without starting a sandbox probe', async () => {
    const supervisor = await import('./supervisor');

    expect(supervisor.probeProviderSandbox).toBeTypeOf('function');
    expect(subprocess.spawn).not.toHaveBeenCalled();
  });
});
