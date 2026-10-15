import { describe, expect, it } from 'vitest';
import docsGet from './get';

describe('docs:get role access', () => {
  it('allows judges to read rubric-mandated runbooks through the read capability', () => {
    expect(docsGet.agentRoles).toContain('judge');
    expect(docsGet.capability).toBe('docs:read');
  });
});
