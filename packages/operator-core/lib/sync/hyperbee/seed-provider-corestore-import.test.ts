import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync,
}));

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  execFileSync.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe('git');
    expect(args.slice(0, 2)).toEqual(['config', '--get']);
    return args[2] === 'user.name' ? 'fixture-build-owner\n' : 'fixture-build-owner@example.invalid\n';
  });
});

describe('seed provider identity discovery', () => {
  it('imports without executing git configuration reads', async () => {
    await import('./seed-provider-corestore');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('uses explicit projection literals without discovering ambient identity', async () => {
    const { redactSeedValue } = await import('./seed-provider-corestore');
    expect(redactSeedValue({ value: 'fixture-explicit-owner' }, ['fixture-explicit-owner']))
      .toEqual({ value: '[build-identity]' });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('discovers default identity on first projection and reuses it afterwards', async () => {
    const { redactSeedValue } = await import('./seed-provider-corestore');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(redactSeedValue('fixture-build-owner@example.invalid')).toBe('[email]');
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync.mock.calls.map(([, args]) => args[2])).toEqual(['user.name', 'user.email']);
    expect(redactSeedValue('fixture-build-owner')).toBe('[build-identity]');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
