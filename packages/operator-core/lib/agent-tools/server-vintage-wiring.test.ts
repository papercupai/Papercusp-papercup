import { afterEach, describe, expect, it } from 'vitest';
import {
  readServerVintage,
  resetServerVintageResolver,
} from '@papercusp/agent-mcp';
import './server-vintage-wiring';

afterEach(() => resetServerVintageResolver());

describe('server-vintage Papercusp wiring', () => {
  it('advertises the staging operator as the current-source recovery route', () => {
    const vintage = readServerVintage();
    expect(vintage?.freshCodeEndpoint).toContain('the Papercusp staging operator at :3170');
    // staging-build-tool-routing-2026-10-21 R-3: the MCP route is the per-call build selector.
    expect(vintage?.freshCodeEndpoint).toContain("build: 'staging'");
    expect(vintage?.freshCodeEndpoint).toContain("tools:invoke { name, args, build: 'staging' }");
    expect(vintage?.freshCodeEndpoint).toContain('with ptool, pass --url=http://127.0.0.1:3170 explicitly');
  });
});
