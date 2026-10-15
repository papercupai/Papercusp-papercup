import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lookupTier } from './tier-table';

describe('lookupTier', () => {
  it('loads the authoring module through native Node ESM without a bundler JSON transform', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      'const { lookupTier } = await import(process.argv[1]); process.stdout.write(JSON.stringify([lookupTier("tasks:read"), lookupTier("secrets:read:OPENAI_KEY"), lookupTier("unknown:cap")]));',
      new URL('./tier-table.ts', import.meta.url).href], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(JSON.parse(output)).toEqual(['low', 'high', null]);
  });

  it('resolves an exact substrate cap', () => {
    expect(lookupTier('messages:write')).toBe('medium');
    expect(lookupTier('tasks:read')).toBe('low');
  });

  it('resolves wildcard prefixes', () => {
    expect(lookupTier('secrets:read:OPENAI_KEY')).toBe('high');
    expect(lookupTier('harness:dispatch:foo')).toBe('high');
    expect(lookupTier('data:read:goals:goal-12')).toBe('medium');
  });

  it('returns null for unknown caps (caller forces high)', () => {
    expect(lookupTier('plugin:custom:thing')).toBeNull();
    expect(lookupTier('made:up:cap')).toBeNull();
  });
});
