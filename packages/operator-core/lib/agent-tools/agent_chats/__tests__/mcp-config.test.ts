/**
 * Unit coverage for agent_chats:chat's scoped MCP tool surface
 * (work-item-chat-context-modernize-2026-07-18, P-004).
 *
 * `buildAgentChatsMcpConfig` is the one IO-touching function (reads the
 * loopback superuser-token file) — made testable via the injectable
 * `readToken` option, same pattern as `plans/runner.ts`'s
 * `buildPlanAgentMcpConfig` tests exercise it live rather than unit-test
 * the token read itself. `agentChatsToolEventFilter` + the tool-name
 * constants are pure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'default-ws' }));
vi.mock('../../../self-url', () => ({ selfUrl: () => 'http://127.0.0.1:3055' }));

import { isValidSuperuserBearer } from '../../../superuser-token';
import {
  AGENT_CHATS_ALLOWED_TOOLS,
  AGENT_CHATS_MCP_TOOLS,
  agentChatsToolEventFilter,
  buildAgentChatsMcpConfig,
} from '../mcp-config';

describe('AGENT_CHATS_MCP_TOOLS / AGENT_CHATS_ALLOWED_TOOLS', () => {
  it('is the exact P-004 read-mostly surface', () => {
    expect(AGENT_CHATS_MCP_TOOLS).toEqual([
      'work_items:get',
      'work_items:list',
      'plans:get',
      'docs:search',
      'memory:search',
      'voice:say',
    ]);
  });

  it('derives the mcp__agentmcp__-prefixed allowed-tools form', () => {
    expect(AGENT_CHATS_ALLOWED_TOOLS).toEqual([
      'mcp__agentmcp__work_items:get',
      'mcp__agentmcp__work_items:list',
      'mcp__agentmcp__plans:get',
      'mcp__agentmcp__docs:search',
      'mcp__agentmcp__memory:search',
      'mcp__agentmcp__voice:say',
    ]);
  });
});

describe('agentChatsToolEventFilter', () => {
  it('strips the mcp__agentmcp__ prefix off an attached-surface tool call', () => {
    expect(agentChatsToolEventFilter('mcp__agentmcp__work_items:get')).toBe('work_items:get');
  });

  it('drops a native builtin tool call (returns null)', () => {
    expect(agentChatsToolEventFilter('Bash')).toBeNull();
    expect(agentChatsToolEventFilter('Read')).toBeNull();
    expect(agentChatsToolEventFilter('Edit')).toBeNull();
  });
});

describe('buildAgentChatsMcpConfig', () => {
  it('returns null when no superuser token is available (unprovisioned build)', () => {
    const cfg = buildAgentChatsMcpConfig({ harness: 'papercusp', readToken: () => '' });
    expect(cfg).toBeNull();
  });

  it('builds an HTTP-direct agentmcp config carrying workspace + tools + harness', () => {
    const cfg = buildAgentChatsMcpConfig({
      harness: 'papercusp',
      workspaceId: 'ws-1',
      readToken: () => 'a-fake-superuser-token-1234567890',
    });
    expect(cfg).not.toBeNull();
    const server = cfg!.mcpServers.agentmcp;
    expect(server.type).toBe('http');
    expect(server.headers.Authorization).toBe('Bearer a-fake-superuser-token-1234567890');
    expect(server.url).toContain('/api/mcp?superuser=1');
    expect(server.url).toContain('&workspace=ws-1');
    expect(server.url).toContain(
      `&tools=${encodeURIComponent('work_items:get,work_items:list,plans:get,docs:search,memory:search,voice:say')}`,
    );
    expect(server.url).toContain('&harness=papercusp');
  });

  it('omits &harness= when no harness is given (still returns a usable config)', () => {
    const cfg = buildAgentChatsMcpConfig({
      readToken: () => 'a-fake-superuser-token-1234567890',
      workspaceId: 'ws-1',
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.mcpServers.agentmcp.url).not.toContain('&harness=');
  });

  it('url-encodes an odd harness slug', () => {
    const cfg = buildAgentChatsMcpConfig({
      harness: 'a/b c',
      workspaceId: 'ws-1',
      readToken: () => 'a-fake-superuser-token-1234567890',
    });
    expect(cfg!.mcpServers.agentmcp.url).toContain('&harness=a%2Fb%20c');
  });

  it('defaults workspaceId to activeWorkspaceId() when not passed', () => {
    const cfg = buildAgentChatsMcpConfig({
      harness: 'papercusp',
      readToken: () => 'a-fake-superuser-token-1234567890',
    });
    expect(cfg!.mcpServers.agentmcp.url).toContain('&workspace=default-ws');
  });

  it('rejects a too-short token as unprovisioned', () => {
    const cfg = buildAgentChatsMcpConfig({ harness: 'papercusp', readToken: () => 'short' });
    expect(cfg).toBeNull();
  });

  // WI-10006617: the DEFAULT reader (no injected readToken) must present the bearer the
  // operator will VALIDATE against — `$PAPERCUSP_HOME/superuser-token` when a scoped home is
  // set (an isolated verify-tauri-headless sidecar). It used to hard-code
  // `homedir()/.papercusp`, so a chat agent spawned by an isolated sidecar presented the
  // real-home bearer and got `superuser_invalid_bearer`.
  describe('default token reader honours PAPERCUSP_HOME', () => {
    let scopedHome: string;
    beforeEach(() => {
      scopedHome = mkdtempSync(join(tmpdir(), 'wi-10006617-home-'));
      writeFileSync(join(scopedHome, 'superuser-token'), 'scoped-home-token-0123456789abcdef\n');
      vi.stubEnv('PAPERCUSP_HOME', scopedHome);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(scopedHome, { recursive: true, force: true });
    });

    it('presents the scoped-home bearer, not the real-home one', () => {
      const cfg = buildAgentChatsMcpConfig({ harness: 'papercusp', workspaceId: 'ws-1' });
      expect(cfg?.mcpServers.agentmcp.headers.Authorization).toBe(
        'Bearer scoped-home-token-0123456789abcdef',
      );
    });

    it('presents the exact bearer the validator accepts', () => {
      const cfg = buildAgentChatsMcpConfig({ harness: 'papercusp', workspaceId: 'ws-1' });
      const bearer = cfg?.mcpServers.agentmcp.headers.Authorization.replace(/^Bearer /, '');
      expect(isValidSuperuserBearer(bearer)).toBe(true);
    });
  });
});
