/**
 * Coverage for console-launcher.shellSafeId — the allowlist guard for session
 * ids embedded in a shell greeting. Accepts only the randomUUID alphabet
 * [0-9a-f-]; throws (rather than escaping) on anything else.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shellSafeId, buildSuperuserMcpUrl, buildConsoleEnvelope } from './console-launcher';
import {
  SPAWN_PATH_DIRS_ENV,
  decodeSpawnPathDirs,
  resolveSpawnPathDirs,
} from './backend-bin-resolve.mjs';

describe('shellSafeId', () => {
  it('accepts a UUID-shaped id', () => {
    const id = '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8';
    expect(shellSafeId(id)).toBe(id);
  });

  it('accepts the hex+dash alphabet case-insensitively', () => {
    expect(shellSafeId('ABCDEF-012345')).toBe('ABCDEF-012345');
  });

  it.each([
    ['has a space', 'abc def'],
    ['shell metachars', 'abc; rm -rf /'],
    ['command substitution', '$(whoami)'],
    ['out-of-alphabet letter', 'deadbeefz'],
    ['empty', ''],
  ])('throws on %s', (_label, bad) => {
    expect(() => shellSafeId(bad)).toThrow(/unsafe session id/);
  });
});

describe('buildSuperuserMcpUrl (scoped-superuser-workspace-clamp D-004)', () => {
  it('scoped-by-default: bakes the concrete workspace so the dispatch clamp confines the session', () => {
    const url = new URL(buildSuperuserMcpUrl('http://localhost:3070', 'generic-test'));
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('workspace')).toBe('generic-test');
  });

  it('allWorkspaces: bakes the UNSCOPED wildcard (the only door past the clamp)', () => {
    const url = new URL(buildSuperuserMcpUrl('http://localhost:3070', 'generic-test', true));
    expect(url.searchParams.get('workspace')).toBe('*');
  });
});

describe('buildConsoleEnvelope backend PATH dirs (WI-37920 / P-001)', () => {
  // A desktop-spawned terminal does not inherit the operator's env, so the
  // BACKEND CLI psu has to exec (claude/codex/omp — and, via its shebang, bun)
  // must be resolved HERE, where the full env exists, and carried as data.
  // Skipped only on a box where no backend is installed at all: there is then
  // genuinely nothing to inject and an assertion would be about the box.
  const expected = resolveSpawnPathDirs().dirs;

  it.skipIf(expected.length === 0)(
    'carries the operator-resolved dirs in the envelope env, so the window can execute the backend',
    async () => {
      const envelope = await buildConsoleEnvelope({
        workspaceId: 'default',
        slug: null,
        operatorBaseUrl: 'http://localhost:3070',
        skipMcpJson: true,
      });

      // The WIRING is the subject: drop the resolve block from buildConsoleEnvelope
      // and this fails, which is the regression that would silently return every
      // desktop launch to "the omp backend is not installed".
      expect(decodeSpawnPathDirs(envelope.env[SPAWN_PATH_DIRS_ENV])).toEqual(expected);
    },
  );

  it.skipIf(expected.length === 0)('encodes only directories that actually exist', async () => {
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      skipMcpJson: true,
    });
    for (const dir of decodeSpawnPathDirs(envelope.env[SPAWN_PATH_DIRS_ENV])) {
      expect(existsSync(dir), `${dir} was injected into a spawned PATH but does not exist`).toBe(true);
    }
  });
});

describe('buildConsoleEnvelope cwd for a workspace-only launch (EI-10938)', () => {
  it('lands in a real CHECKOUT, never the .papercusp state dir', async () => {
    // The regression: a no-slug launch (which is what EVERY su session is) used to
    // get cwd = `<workspace>/.papercusp` — a state dir that is not even a git repo.
    // Bare `git` failed there, and relative paths silently resolved into it. Claude
    // Code resets the shell cwd to the launch dir after every command, so the
    // workaround cost a defensive `cd` on 77% of all bash calls.
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      skipMcpJson: true,
    });

    // The cwd must be a checkout — carry the two repo markers…
    expect(existsSync(join(envelope.cwd, 'apps', 'operator', 'package.json'))).toBe(true);
    expect(existsSync(join(envelope.cwd, 'libs', 'papercusp', 'package.json'))).toBe(true);
    // …and, critically, be a git repository, which the state dir was not.
    expect(existsSync(join(envelope.cwd, '.git'))).toBe(true);
    // The old broken value was a `.papercusp` state dir. Never again.
    expect(envelope.cwd.endsWith('/.papercusp')).toBe(false);
  });

  it('exports PAPERCUSP_REPO_ROOT so no agent has to hard-code an absolute repo path', async () => {
    // Agents had PAPERCUSP_HOME (state dir) and PAPERCUSP_WORKSPACE (an id) but
    // nothing naming where the CODE lives — so 287 command lines in a single
    // session hard-coded a box-specific absolute path.
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      skipMcpJson: true,
    });
    expect(envelope.env.PAPERCUSP_REPO_ROOT).toBe(envelope.cwd);
    expect(envelope.env.PAPERCUSP_NODE_RUNTIME_DIR).toBe(dirname(process.execPath));
    expect(existsSync(join(envelope.env.PAPERCUSP_REPO_ROOT!, '.git'))).toBe(true);
  });
});

describe('buildConsoleEnvelope retained Node boundary', () => {
  const originalExecPath = process.execPath;
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'console-retained-node-')); });
  afterEach(() => {
    process.execPath = originalExecPath;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('carries explicit retained Node to checkout CLIs from a Bun parent', async () => {
    const bin = join(root, 'retained', 'bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(originalExecPath, join(bin, 'node'));
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', bin);
    process.execPath = join(root, 'bun');

    const envelope = await buildConsoleEnvelope({ workspaceId: 'default', slug: null,
      operatorBaseUrl: 'http://localhost:3070', skipMcpJson: true });
    expect(envelope.env.PAPERCUSP_NODE_RUNTIME_DIR).toBe(bin);
  });

  it('refuses an unidentified executable named node instead of exporting it to checkout CLIs', async () => {
    const executable = join(root, 'node');
    if (process.env.PAPERCUSP_RUNTIME_TEST_BUN) symlinkSync(process.env.PAPERCUSP_RUNTIME_TEST_BUN, executable);
    else writeFileSync(executable, '', { mode: 0o755 });
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    process.execPath = executable;

    await expect(buildConsoleEnvelope({ workspaceId: 'default', slug: null,
      operatorBaseUrl: 'http://localhost:3070', skipMcpJson: true })).rejects.toThrow(/retained Node/);
  });
});

describe('buildConsoleEnvelope resume greeting permission posture (owner-hit 2026-07-07)', () => {
  const ORIGINAL_AGENT_CMD = process.env.AGENT_CMD;
  const ORIGINAL_CLAUDE_CMD = process.env.CLAUDE_CMD;
  const ORIGINAL_BACKEND = process.env.AGENT_BACKEND;
  afterEach(() => {
    if (ORIGINAL_AGENT_CMD === undefined) delete process.env.AGENT_CMD;
    else process.env.AGENT_CMD = ORIGINAL_AGENT_CMD;
    if (ORIGINAL_CLAUDE_CMD === undefined) delete process.env.CLAUDE_CMD;
    else process.env.CLAUDE_CMD = ORIGINAL_CLAUDE_CMD;
    if (ORIGINAL_BACKEND === undefined) delete process.env.AGENT_BACKEND;
    else process.env.AGENT_BACKEND = ORIGINAL_BACKEND;
  });

  it('claude resume routes through psu — psu carries the auth-correct bypass posture (WI-4159, owner-hit 2026-07-11)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      skipMcpJson: true,
    });
    // A bare `claude -r` under the session's isolated CLAUDE_CONFIG_DIR prompts
    // /login (the isolation dir has the credential symlink but not ~/.claude.json
    // account state) — psu's own resume path does the credential relocation that
    // makes it authenticated, so the greeting routes through psu instead.
    expect(envelope.greetingCmd).toContain(
      'exec psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
    );
  });

  it('omp resume carries --approval-mode yolo', async () => {
    process.env.AGENT_CMD = 'omp';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: 'abc-123',
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).toContain('exec omp --approval-mode yolo -r abc-123');
  });

  // WI-3882: forking a LIVE session must branch into a fresh session id rather
  // than resume in place (a second CLI on the same transcript collides with the
  // still-running original). Since WI-4159 the claude path routes through psu,
  // which takes `--fork` (not claude's own `--fork-session`) to branch.
  it('claude fork appends --fork via psu and says "forking"', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      fork: true,
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).toContain(
      'exec psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8 --fork',
    );
    expect(envelope.greetingCmd).toContain('forking plan-run');
  });

  it('claude resume WITHOUT fork never emits --fork-session (guard against a stray branch)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).not.toContain('--fork-session');
    expect(envelope.greetingCmd).toContain('resuming plan-run');
  });

  it('omp fork is refused (no native branch command) instead of colliding via a plain resume', async () => {
    process.env.AGENT_CMD = 'omp';
    delete process.env.AGENT_BACKEND;
    await expect(
      buildConsoleEnvelope({
        workspaceId: 'default',
        slug: null,
        operatorBaseUrl: 'http://localhost:3070',
        resumeSessionId: 'abc-123',
        fork: true,
        skipMcpJson: true,
      }),
    ).rejects.toThrow(/only claude sessions support --fork-session/);
  });

  it('directs a Codex console fork to the tracked native launcher', async () => {
    process.env.AGENT_CMD = 'codex';
    delete process.env.AGENT_BACKEND;
    await expect(buildConsoleEnvelope({
      workspaceId: 'default', slug: null, operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8', fork: true, skipMcpJson: true,
    })).rejects.toThrow('psu --resume=<tracked-session> --fork');
  });

  // WI-6510 (hud-chat-owner-controls-2026-08-11 P-002): the chat footer's MODEL
  // pill resumes a session onto a DIFFERENT model. These guard the seam D-007
  // named as the whole risk — a model change that appears to apply and does not.
  it('resumeModel emits psu --model, QUOTED (the spec alphabet contains shell globs)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      resumeModel: 'opus[1m]:high',
      skipMcpJson: true,
    });
    // Single-quoted, because `[`/`]` are real shell globs and the `[1m]` window
    // marker is load-bearing — an unquoted spec would glob-expand or vanish.
    expect(envelope.greetingCmd).toContain(`--model='opus[1m]:high'`);
    // The COMPOSED spec travels as one token. psu has no --effort flag and drops
    // unrecognized flags silently, so splitting it here is the silent no-op.
    expect(envelope.greetingCmd).not.toContain('--effort');
  });

  it('fork + resumeModel COMPOSE — the exact shape the MODEL pill posts', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      fork: true,
      resumeModel: 'sonnet[1m]',
      skipMcpJson: true,
    });
    // The pill always forks: the popup is attached to a LIVE session, and psu
    // threads both flags through one argv (psu-launcher.mjs:1197).
    expect(envelope.greetingCmd).toContain('--fork');
    expect(envelope.greetingCmd).toContain(`--model='sonnet[1m]'`);
  });

  it('a resume WITHOUT resumeModel emits no --model (guard against a stray re-point)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).not.toContain('--model');
  });

  it('REFUSES a model on a non-claude resume rather than dropping it silently', async () => {
    process.env.AGENT_CMD = 'omp';
    delete process.env.AGENT_BACKEND;
    // omp/codex exec the bare binary, so the flag would never reach the CLI — the
    // session would resume on the OLD model while the UI reported the new one.
    await expect(
      buildConsoleEnvelope({
        workspaceId: 'default',
        slug: null,
        operatorBaseUrl: 'http://localhost:3070',
        resumeSessionId: 'abc-123',
        resumeModel: 'opus[1m]:high',
        skipMcpJson: true,
      }),
    ).rejects.toThrow(/only claude sessions resume through psu/);
  });

  it('REFUSES a spec carrying shell metacharacters instead of escaping it', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    await expect(
      buildConsoleEnvelope({
        workspaceId: 'default',
        slug: null,
        operatorBaseUrl: 'http://localhost:3070',
        resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
        resumeModel: 'sonnet; rm -rf /',
        skipMcpJson: true,
      }),
    ).rejects.toThrow(/unsafe model spec/);
  });

  // resume-in-gui-button-2026-08-09 — "Resume in GUI": the same in-place resume, minus
  // the terminal window, because the human will talk to it in the HUD conversation
  // popup instead. `--headless` is the load-bearing part: it is what keeps psu's
  // managed pty alive under non-TTY stdio, i.e. what keeps the resumed session
  // INJECTABLE for the popup's `coord:send { wake:'required' }` composer. A windowless
  // resume without it parks after one turn and nothing can reach it.
  it('claude resume with headless appends --headless to the psu resume', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      headless: true,
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).toContain(
      'exec psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8 --headless',
    );
    // Still a resume IN PLACE — the GUI button must never quietly branch.
    expect(envelope.greetingCmd).not.toContain('--fork');
  });

  // The headed path must stay BYTE-IDENTICAL — this is the control for the case
  // above. Without it, an unconditional `--headless` would pass the assertion there
  // and silently window-less every ordinary "Resume in new terminal" too.
  it('claude resume WITHOUT headless emits no --headless (the terminal path is unchanged)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).not.toContain('--headless');
  });

  it('claude fork + headless keeps BOTH flags (they are orthogonal)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      fork: true,
      headless: true,
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).toContain(
      'exec psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8 --fork --headless',
    );
  });

  // Refused for the same structural reason fork is, one step further: the codex/omp
  // branch execs the BARE interactive CLI rather than routing through psu, so it
  // registers no coord presence and hosts no injectable pty. Headless, that is a
  // process no GUI conversation could ever reach — so fail loudly instead of
  // spawning something invisible and unreachable.
  it('omp resume in GUI is refused (bare CLI ⇒ no presence, no injectable pty)', async () => {
    process.env.AGENT_CMD = 'omp';
    delete process.env.AGENT_BACKEND;
    await expect(
      buildConsoleEnvelope({
        workspaceId: 'default',
        slug: null,
        operatorBaseUrl: 'http://localhost:3070',
        resumeSessionId: 'abc-123',
        headless: true,
        skipMcpJson: true,
      }),
    ).rejects.toThrow(/only claude sessions resume through psu/);
  });
});

describe('buildConsoleEnvelope PAPERCUSP_OPERATOR_URL (WI-1773 follow-up)', () => {
  const routingKeys = ['PAPERCUSP_HONO_PORT', 'PAPERCUSP_BG_HOST_AGENTS_MCP_BASE',
    'PAPERCUSP_MCP_PROXY_BASE', 'PAPERCUSP_MCP_PROXY_TARGET_PORT', 'PAPERCUSP_MCP_STAGING_PROXY_PORT'];
  const originalRouting = new Map(routingKeys.map(key => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of routingKeys) delete process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of originalRouting) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the stable proxy fallback for a long-lived session when no proxy base is configured', async () => {
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      runCommand: 'true',
      skipMcpJson: true,
    });
    expect(envelope.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
    expect(envelope.env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
  });

  it('routes the child env through the resilient proxy when PAPERCUSP_MCP_PROXY_BASE is set — a console/fleet/capability:terminal launch must NOT permanently pin :3070 past a spawned session (the exact WI-1773 regression: an inherited PAPERCUSP_OPERATOR_URL override silently disables psu-launcher\'s proxy-first default)', async () => {
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      runCommand: 'true',
      skipMcpJson: true,
    });
    expect(envelope.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
  });

  it.each([
    ['same-runtime proxy', 'http://127.0.0.1:9271', '3271', 'http://127.0.0.1:9271', '9271'],
    ['live proxy', 'http://127.0.0.1:9071', '3070', 'http://localhost:3271', '3271'],
  ])('honors an explicit background runtime in both the launch env and MCP config (%s)', async (_name, proxy, targetPort, pinnedBase, pinnedPort) => {
    const keys = ['PAPERCUSP_HONO_PORT', 'PAPERCUSP_BG_HOST_AGENTS_MCP_BASE',
      'PAPERCUSP_MCP_PROXY_BASE', 'PAPERCUSP_MCP_PROXY_TARGET_PORT'];
    const saved = new Map(keys.map(key => [key, process.env[key]]));
    process.env.PAPERCUSP_HONO_PORT = '3271';
    process.env.PAPERCUSP_BG_HOST_AGENTS_MCP_BASE = 'http://127.0.0.1:9071';
    process.env.PAPERCUSP_MCP_PROXY_BASE = proxy;
    process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT = targetPort;
    try {
      const ordinary = await buildConsoleEnvelope({
        workspaceId: 'default', slug: null, operatorBaseUrl: 'http://localhost:3271',
        runCommand: 'true',
      });
      const pinned = await buildConsoleEnvelope({
        workspaceId: 'default', slug: null, operatorBaseUrl: 'http://localhost:3271',
        agentMcpBaseUrl: 'http://localhost:3271', runCommand: 'true',
      });
      expect(ordinary.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
      expect(pinned.env.PAPERCUSP_OPERATOR_URL).toBe(pinnedBase);
      for (const [envelope, port] of [[ordinary, '9071'], [pinned, pinnedPort]] as const) {
        const servers = JSON.parse(envelope.mcpJsonContents).mcpServers;
        expect(Object.values(servers)).toHaveLength(1);
        const { url } = Object.values(servers)[0] as { url: string };
        expect(new URL(url).port).toBe(port);
        expect(new URL(url).searchParams.get('workspace')).toBe('default');
      }
      expect(pinned.env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('keeps a fleet session off the staging host port unless an A/B endpoint is explicit', async () => {
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3170',
      runCommand: 'true',
      skipMcpJson: true,
    });
    expect(envelope.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');

    const abEnvelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3170',
      agentMcpBaseUrl: 'http://localhost:3170',
      runCommand: 'true',
      skipMcpJson: true,
    });
    expect(abEnvelope.env.PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3170');
    expect(envelope.env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
    expect(abEnvelope.env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('');
  });
});

describe('buildConsoleEnvelope account routing (EI-21575557995965463)', () => {
  it('carries the explicit default route marker in the child environment', async () => {
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      runCommand: 'true',
      skipMcpJson: true,
    });

    // psu uses this envelope marker to clear inherited gateway credentials;
    // without it, --account=default can silently keep the parent route.
    expect(envelope.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
  });
});
