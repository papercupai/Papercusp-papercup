import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';
// Import the production registration path without importing the equity leaf.
import '../index';
describe('pot:equity production registration', () => {
  it('exposes the equity adapter through the real authenticated tool registry', () => {
    const tool = lookupByMcpName('pot:equity');
    expect(tool).toBeDefined();
    expect(tool!.requirePrincipal).not.toBe(false);
    expect(tool!.capabilities).toContain('harness:read');
  });
});
