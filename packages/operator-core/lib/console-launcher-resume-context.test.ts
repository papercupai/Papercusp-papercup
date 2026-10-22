// @vitest-environment node
/**
 * console-launcher resume launch-context (WI-3988/WI-3989, owner-hit 2026-07-11).
 *
 * `claude -r <id>` reported "No conversation found with session ID" and exited 1
 * because papercusp runs each claude agent in a per-session ISOLATION home
 * (~/.papercusp/session-claude/<owner>) and the move-inactive-sessions-to-PG
 * lifecycle archives+deletes the on-disk jsonl — but the resume envelope set
 * neither CLAUDE_CONFIG_DIR nor the original cwd, and never rematerialized. These
 * tests pin that a claude resume now: (1) sets CLAUDE_CONFIG_DIR to the session's
 * isolation home, (2) lands in the session's original cwd, (3) rematerializes the
 * archived transcript from PG first — and that a miss degrades to a bare -r.
 *
 * WI-4159 (owner-hit 2026-07-11): the greeting itself now routes a claude
 * resume/fork THROUGH `psu --resume=<id>` (not a bare `claude -r <id>`) — psu's
 * own resume path does the CLAUDE_CONFIG_DIR→credential relocation that makes
 * the isolated config dir authenticated, which a bare `claude -r` under it does
 * not get (it hit /login). The CLAUDE_CONFIG_DIR/cwd/rematerialize behavior
 * this suite pins is UNCHANGED by that — only the final greetingCmd shape is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve a row for the "found" session ids; [] for the "missing" one — so both
// the happy path and the graceful-fallback path are exercised from one mock.
vi.mock('./adv-sessions', async (orig) => ({ ...(await orig<typeof import('./adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  advSessionsByTranscriptHandles: vi.fn(async ({ sessionIds }: { sessionIds?: string[] }) => {
    const id = sessionIds?.[0];
    if (id === 'ffffffff-0000-0000-0000-000000000000') return [];
    if (id === '44444444-0000-0000-0000-000000000000') {
      return [{ id: 42, agent: 'codex', coordOwnerId: 'su-codex-1', cwd: process.cwd(),
        launchArgv: ['psu', '--account=auto'] }];
    }
    const launchArgv = id === '11111111-0000-0000-0000-000000000000'
      ? ['psu', '--account=auto']
      : id === '22222222-0000-0000-0000-000000000000'
        ? ['psu', '--account=acct-source']
        : id === '33333333-0000-0000-0000-000000000000'
          ? ['psu', '--account=acct;unsafe']
          : null;
    return [{ coordOwnerId: 'su-owner-1', cwd: process.cwd(), launchArgv }];
  }),
}));
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({
  codexHomeForSessionKey: (sessionKey: string | number) => `/tmp/su-codex-homes/session-${sessionKey}`,
  sessionClaudeConfigDir: (owner: string) => `/tmp/session-claude/${owner}`,
}));
vi.mock('./session-archive', () => ({
  pgSessionArchiveStore: () => ({}),
  rematerializeSession: vi.fn(async () => ({ ok: false, reason: 'not_archived' })),
}));

import { buildConsoleEnvelope } from './console-launcher';

const BASE = { workspaceId: 'default', slug: null, operatorBaseUrl: 'http://localhost:3070', skipMcpJson: true } as const;

describe('buildConsoleEnvelope resume launch-context (WI-3988/WI-3989)', () => {
  beforeEach(() => { process.env.AGENT_CMD = 'claude'; delete process.env.AGENT_BACKEND; });
  afterEach(() => { delete process.env.AGENT_CMD; vi.clearAllMocks(); });

  it('points a claude resume at the session isolation home + original cwd so `-r` finds the conversation', async () => {
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8' });
    expect(env.env.CLAUDE_CONFIG_DIR).toBe('/tmp/session-claude/su-owner-1');
    expect(env.cwd).toBe(process.cwd());
    expect(env.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
    expect(env.greetingCmd).not.toContain('--account=');
    expect(env.greetingCmd).toContain('psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8');
  });

  it('rematerializes the archived session from PG before resuming', async () => {
    const { rematerializeSession } = await import('./session-archive');
    await buildConsoleEnvelope({ ...BASE, resumeSessionId: 'baa78575-0d5b-462c-864f-2aa0b64acfea' });
    expect(rematerializeSession).toHaveBeenCalledWith(
      { sourceKind: 'claude', sessionId: 'baa78575-0d5b-462c-864f-2aa0b64acfea' },
      expect.anything(),
    );
  });

  it('a fork still branches (--fork-session) AND points at the isolation home', async () => {
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: '7a3f6064-4904-4c00-ab63-33a72e6c419d', fork: true });
    expect(env.env.CLAUDE_CONFIG_DIR).toBe('/tmp/session-claude/su-owner-1');
    expect(env.greetingCmd).toContain('--fork');
  });

  it('carries a source session auto route through a model fork', async () => {
    const env = await buildConsoleEnvelope({
      ...BASE,
      resumeSessionId: '11111111-0000-0000-0000-000000000000',
      fork: true,
      resumeModel: 'sonnet[1m]:high',
    });
    expect(env.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
    expect(env.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect(env.env.ANTHROPIC_AUTH_TOKEN).toBe('papercusp-gateway');
    expect(env.env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-papercusp-owner: su-owner-1');
    expect(env.greetingCmd).toContain('--fork');
    expect(env.greetingCmd).toContain("--model='sonnet[1m]:high'");
    expect(env.greetingCmd).toContain('--account=auto');
  });

  it('carries a source session account pin through a fork', async () => {
    const env = await buildConsoleEnvelope({
      ...BASE,
      resumeSessionId: '22222222-0000-0000-0000-000000000000',
      fork: true,
    });
    expect(env.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('pin');
    expect(env.env.PAPERCUSP_ACCOUNT_ID).toBe('acct-source');
    expect(env.greetingCmd).toContain('--account=acct-source');
    expect(env.greetingCmd).toContain('--fork');
  });

  it('resumes tracked Codex from its isolated home and preserves the gateway route', async () => {
    const id = '44444444-0000-0000-0000-000000000000';
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: id });
    expect(env.env.CODEX_HOME).toBe('/tmp/su-codex-homes/session-42');
    expect(env.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
    expect(env.env.PAPERCUSP_CODEX_GATEWAY).toBe('1');
    expect(env.greetingCmd).toContain(`exec codex -r ${id}`);
  });

  it('rejects an unsafe recorded account before embedding it in the resume command', async () => {
    await expect(
      buildConsoleEnvelope({ ...BASE, resumeSessionId: '33333333-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/unsafe account/);
  });

  it('degrades to a bare psu --resume (no CLAUDE_CONFIG_DIR) when the session has no adv row', async () => {
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: 'ffffffff-0000-0000-0000-000000000000' });
    expect(env.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // psu itself re-derives + resolves the session across the isolation dirs, so
    // the miss here just means WE didn't set CLAUDE_CONFIG_DIR up-front — the
    // greeting still routes through psu (WI-4159), not a bare `claude -r`.
    expect(env.greetingCmd).toContain('psu --resume=ffffffff-0000-0000-0000-000000000000');
  });
});
