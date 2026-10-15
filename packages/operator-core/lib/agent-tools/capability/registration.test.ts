/**
 * Registration smoke test (P-010, B-05): importing each capability tool module
 * must project it into the shared catalog with the right MCP name, capability
 * string, and fleet agentRoles. Verifies the defineTool wiring end-to-end
 * (name derivation, tier lookup, role allowlist) without a live operator.
 */
import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import './bash';
import './bash_output';
import './bash_kill';
import './pty';
import './read';
import './write';
import './edit';
import './git';
import './git-evidence';
import './fetch';
import './inspect';

const EXPECTED: Array<{ name: string; capability: string }> = [
  { name: 'capability:bash', capability: 'capability:bash' },
  { name: 'capability:bash_output', capability: 'capability:bash' },
  { name: 'capability:bash_kill', capability: 'capability:bash' },
  { name: 'capability:pty_open', capability: 'capability:bash' },
  { name: 'capability:pty_write_stdin', capability: 'capability:bash' },
  { name: 'capability:pty_resize', capability: 'capability:bash' },
  { name: 'capability:pty_read_screen', capability: 'capability:bash' },
  { name: 'capability:pty_kill', capability: 'capability:bash' },
  { name: 'capability:read', capability: 'capability:fs-read' },
  { name: 'capability:write', capability: 'capability:fs-write' },
  { name: 'capability:edit', capability: 'capability:fs-write' },
  { name: 'capability:git', capability: 'capability:git' },
  { name: 'capability:fetch', capability: 'capability:net' },
  // EI-524 / P-035: read-only verification exec (capability:code-inspect, low tier).
  { name: 'capability:inspect', capability: 'capability:code-inspect' },
];

describe('capability tool registration', () => {
  for (const e of EXPECTED) {
    it(`projects ${e.name} with capability ${e.capability} for fleet roles`, () => {
      const tool = lookupByMcpName(e.name);
      expect(tool, `${e.name} not registered`).toBeDefined();
      expect(tool!.capabilities).toContain(e.capability);
      // The fleet execution roles (SU_ROLES + bee) must be allowed.
      expect(tool!.agentRoles).toContain('worker');
      expect(tool!.agentRoles).toContain('cup');
    });
  }

  it('projects the structured pinned Git evidence reader only for judges', () => {
    const tool = lookupByMcpName('capability:git-evidence');
    expect(tool, 'capability:git-evidence not registered').toBeDefined();
    expect(tool!.capabilities).toContain('capability:git-evidence:read');
    expect(tool!.agentRoles).toEqual(['judge']);
  });

  it('the file-mutation tools carry guidance (tools-md-sync requirement)', () => {
    for (const name of ['capability:write', 'capability:edit', 'capability:bash']) {
      const tool = lookupByMcpName(name);
      expect(tool!.guidance?.when, `${name} missing guidance.when`).toBeTruthy();
    }
  });

  it('documents the dual Accept header required by MCP streamable HTTP', () => {
    const tool = lookupByMcpName('capability:fetch');
    expect(tool!.description).toContain('application/json, text/event-stream');
    expect(tool!.guidance?.when).toContain('application/json alone returns 406');
  });

  it('keeps background output polling out of ambient workspace transactions', () => {
    const tool = lookupByMcpName('capability:bash_output');
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});
