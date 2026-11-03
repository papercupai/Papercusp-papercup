import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deriveRecipeAuthority } from '../../recipe-authority-derive';

// Persist this exact source with recipes:revise, then read it back for equality.
const script = readFileSync(new URL('./fixtures/inspect-git-sync-lock.recipe.txt', import.meta.url), 'utf8');
const subject = { installSlug: 'papercusp', resource: 'git-sync:papercusp' };
const currentOwner = 'system:git-sync:36733:fa04ed74';

function run(source = script, inputs: Record<string, unknown> = subject) {
  const locks = vi.fn(async (_args: unknown) => ({
    resources: [{ resource: subject.resource }],
    holders: [
      { resource: 'git-sync:other', owner: 'other-holder', mode: 'shared', status: 'held' },
      { resource: subject.resource, owner: currentOwner, mode: 'exclusive', status: 'held', expires_ts: null },
    ],
    draining: false,
    registryCount: { truncatedByLimit: false },
  }));
  const context = vm.createContext({ inputs, tools: { locks: { list: locks } } });
  const result = vm.runInContext('(async () => { ' + source + '\n })()', context) as Promise<Record<string, any>>;
  return { result, locks };
}

describe('saved git-sync lock inspection recipe', () => {
  it('resolves the current holder through a stable resource filter', async () => {
    expect(await deriveRecipeAuthority(script)).toMatchObject({ unresolved: false, bound: false });
    expect(script).toContain('tools.locks.list({ resource })');
    expect(script).not.toContain('system:git-sync:');
    expect(script).not.toContain('tools.locks.queue');

    const current = run();
    const actual = await current.result;
    expect(current.locks).toHaveBeenCalledWith({ resource: subject.resource });
    expect(actual).toMatchObject({
      request: subject,
      registered: true,
      draining: false,
      scopeComplete: true,
      holderCount: 1,
      holders: [{ owner: currentOwner, mode: 'exclusive', status: 'held', expiresAt: null }],
    });
  });

  it.each([
    {},
    { installSlug: 'papercusp' },
    { installSlug: 'papercusp', resource: 'git-sync:other' },
    { installSlug: '', resource: 'git-sync:' },
  ])('rejects missing or mismatched scope before reading: %j', async inputs => {
    const current = run(script, inputs);
    await expect(current.result).rejects.toThrow('Explicit installSlug');
    expect(current.locks).not.toHaveBeenCalled();
  });
});
