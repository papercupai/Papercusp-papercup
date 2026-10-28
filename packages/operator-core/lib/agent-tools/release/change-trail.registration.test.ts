import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

// Load the real barrel, so dropping the import from agent-tools/index.ts fails here
// even though the module's own unit suite imports it directly.
import '../index';

describe('release:change-trail registration', () => {
  it('is reachable through the production agent-tools barrel', () => {
    expect(
      lookupByMcpName('release:change-trail'),
      'release:change-trail missing from the agent-tools projection registry',
    ).toBeTruthy();
  });
});
