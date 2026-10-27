/**
 * interactive-claude-config.test.ts — the EI-155 interactive-claude
 * CLAUDE_CONFIG_DIR materializer (unify-launch-mechanics D-002, the C1/C5
 * cross-agent isolation class).
 *
 * The contract under test: an interactive claude session gets a per-session
 * config dir that is a SYMLINK MIRROR of the user's ~/.claude with exactly one
 * thing isolated — the `projects/` transcript store — plus the sibling
 * ~/.claude.json symlinked in. That is what keeps the user-level MCP / lock
 * hooks / plugins / onboarding-trust while giving the session its OWN transcript
 * store (so `/resume` + wake-by-uuid never reach a peer's conversation, the
 * EI-153 root). A creds-only dir (the headless bee path) would strip all of the
 * above for a human session — these tests pin that it does NOT.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import ts from 'typescript';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { papercuspPtyPath } from '@papercusp/host-platform/home';
import { RTK_SESSION_ENV } from './agent-tools/capability/rtk-rewrite';
import {
  ensureInteractiveClaudeConfig,
  ensureOnboardingComplete,
  ensureProjectTrust,
  isInteractiveClaudeConfigReady,
  RECOVER_HOOK,
  RECOVER_HOOK_SOURCE,
  RECOVER_INTENT,
  RECOVER_PLAYBOOK,
  syncPersonalClaudeMemory,
  writeInteractiveClaudeConfig,
} from './interactive-claude-config';

const savedRoot = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
let root: string; // the per-session CLAUDE_CONFIG_DIR root (override)
let home: string; // a fake source HOME with a populated ~/.claude

/** Build a realistic fake source HOME: ~/.claude/{.credentials.json, settings.json,
 *  plugins/, commands/, projects/<hash>/<uuid>.jsonl} + ~/.claude.json. */
function seedHome(h: string) {
  const c = join(h, '.claude');
  mkdirSync(join(c, 'plugins'), { recursive: true });
  mkdirSync(join(c, 'commands'), { recursive: true });
  mkdirSync(join(c, 'projects', 'proj-hash'), { recursive: true });
  writeFileSync(join(c, '.credentials.json'), '{"token":"REAL"}');
  writeFileSync(join(c, 'settings.json'), '{"hooks":{"PreToolUse":[]}}');
  writeFileSync(join(c, 'plugins', 'config.json'), '{"verdict":true}');
  // P-020 prune fixtures: a realistic installed_plugins registry + a heavy mcpServer.
  writeFileSync(
    join(c, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'github@claude-plugins-official': [{ scope: 'user' }],
        'cloudflare@claude-plugins-official': [{ scope: 'user' }],
        'firecrawl@claude-plugins-official': [{ scope: 'user' }],
        'context7@claude-plugins-official': [{ scope: 'user' }],
      },
    }),
  );
  writeFileSync(join(c, 'commands', 'foo.md'), '# /foo');
  // The user's PERSONAL global memory — must NOT leak into a psu session
  // (psu-isolation P-002 / D-001). On this box CLAUDE.md = `@AGENTS.md`.
  writeFileSync(join(c, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(c, 'AGENTS.md'), '# Personal rules\nAlways edit topic files, never MEMORY.md.\n');
  // A PEER's transcript already in the shared store — must NOT appear isolated.
  writeFileSync(join(c, 'projects', 'proj-hash', 'peer-uuid.jsonl'), '{"peer":1}');
  writeFileSync(join(h, '.claude.json'), '{"mcpServers":{"papercusp-su":{},"playwright":{}}}');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icc-root-'));
  home = mkdtempSync(join(tmpdir(), 'icc-home-'));
  process.env.PAPERCUSP_SESSION_CLAUDE_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
  else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = savedRoot;
});

/**
 * The mirror symlinks the global ~/.claude.json in and ASSUMES it says
 * onboarding-is-done. When it doesn't, claude boots its first-run wizard, the
 * session never reaches a prompt, and the launch kickoff can never land — the
 * agent is dead on arrival with no error at all. Live-caught 2026-07-12 by the
 * launch-agent live-verify (the flag had flipped to false), and self-
 * propagating: the session's .claude.json is a write-through symlink, so the
 * wedged session writes its not-yet-onboarded state back to the global file.
 */
describe('ensureOnboardingComplete (the first-run wizard blocks every interactive launch)', () => {
  const read = () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));

  it('repairs a global config whose onboarding flag flipped to false', async () => {
    seedHome(home);
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: false, mcpServers: { 'papercusp-su': {} } }),
    );

    expect(await ensureOnboardingComplete(home)).toBe(true);
    expect(read().hasCompletedOnboarding).toBe(true);
    // Never a foreign value: the repair touches exactly the one key.
    expect(read().mcpServers).toEqual({ 'papercusp-su': {} });
  });

  it('repairs a config that never carried the flag, and leaves a healthy one untouched', async () => {
    seedHome(home); // seeds a .claude.json with no onboarding key at all
    expect(await ensureOnboardingComplete(home)).toBe(true);
    expect(read().hasCompletedOnboarding).toBe(true);

    // Idempotent — already-true means no rewrite (peers rewrite this file constantly).
    expect(await ensureOnboardingComplete(home)).toBe(false);
  });

  it('WI-4431: materializes a minimal onboarding-complete config when NONE exists at all', async () => {
    // No seedHome() — a box that has never run claude interactively (e.g. a
    // freshly provisioned headless fleet host). The mirror only symlinks
    // .claude.json in when one exists, so leaving this a no-op would still
    // wedge a headless launch at the first-run wizard by a different door.
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(await ensureOnboardingComplete(home)).toBe(true);
    expect(read().hasCompletedOnboarding).toBe(true);
    // Deliberately bare: no mcpServers (psu supplies MCP via --mcp-config argv,
    // never this file) and no theme key (see the doc comment above).
    expect(read().mcpServers).toBeUndefined();
    expect(read().theme).toBeUndefined();
    // Idempotent on the next call — already-true means no rewrite.
    expect(await ensureOnboardingComplete(home)).toBe(false);
  });

  it('fails open on an unparseable config — a launch never dies here', async () => {
    writeFileSync(join(home, '.claude.json'), '{ not json');
    expect(await ensureOnboardingComplete(home)).toBe(false);
  });
});

/**
 * EI-16574: a brand-new project cwd (no prior `projects[cwd]` entry at all —
 * e.g. a fresh `pot:create_from_repo` clone) trips the "Allow external
 * CLAUDE.md file imports?" / "Do you trust the files in this folder?" TTY
 * prompts, which a HEADLESS launch has nobody to answer — it hangs forever.
 * `ensureProjectTrust` pre-accepts those per-project flags, mirroring how
 * `ensureOnboardingComplete` above pre-accepts the GLOBAL onboarding flag.
 */
describe('ensureProjectTrust (EI-16574: a brand-new cwd wedges a headless launch on a TTY prompt)', () => {
  const read = () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  const cwd = '/home/someuser/.papercusp-workspaces/clones/fresh-clone';

  it('adds a full trust entry for a cwd with NO prior projects[] entry at all', async () => {
    seedHome(home); // seeds a .claude.json with mcpServers but no `projects` key
    expect(await ensureProjectTrust(home, cwd)).toBe(true);
    expect(read().projects[cwd]).toEqual({
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
      hasCompletedProjectOnboarding: true,
    });
    // Never touches a foreign top-level key.
    expect(read().mcpServers).toEqual({ 'papercusp-su': {}, playwright: {} });
  });

  it('repairs a cwd entry that exists but is missing one of the trust flags — never clobbers its other fields', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          [cwd]: {
            mcpServers: { playwright: {} },
            hasTrustDialogAccepted: true,
            hasClaudeMdExternalIncludesApproved: false, // the live EI-16574 wedge shape
            lastSessionId: 'keep-me',
          },
          '/some/other/project': { hasCompletedProjectOnboarding: true },
        },
      }),
    );
    expect(await ensureProjectTrust(home, cwd)).toBe(true);
    const p = read().projects[cwd];
    expect(p.hasClaudeMdExternalIncludesApproved).toBe(true);
    expect(p.hasClaudeMdExternalIncludesWarningShown).toBe(true);
    expect(p.hasCompletedProjectOnboarding).toBe(true);
    // Preserves this project's own unrelated fields...
    expect(p.mcpServers).toEqual({ playwright: {} });
    expect(p.lastSessionId).toBe('keep-me');
    // ...and never touches a SIBLING project's entry.
    expect(read().projects['/some/other/project']).toEqual({ hasCompletedProjectOnboarding: true });
  });

  it('is idempotent — a cwd already fully trusted is left untouched (no rewrite)', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          [cwd]: {
            hasTrustDialogAccepted: true,
            hasClaudeMdExternalIncludesApproved: true,
            hasClaudeMdExternalIncludesWarningShown: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      }),
    );
    expect(await ensureProjectTrust(home, cwd)).toBe(false);
  });

  it('WI-4431-style: materializes a minimal trusted config when NO .claude.json exists at all', async () => {
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(await ensureProjectTrust(home, cwd)).toBe(true);
    expect(read().hasCompletedOnboarding).toBe(true);
    expect(read().projects[cwd].hasClaudeMdExternalIncludesApproved).toBe(true);
  });

  it('fails open on an unparseable config — a launch never dies here', async () => {
    writeFileSync(join(home, '.claude.json'), '{ not json');
    expect(await ensureProjectTrust(home, cwd)).toBe(false);
  });

  it('preserves every project when launches update trust concurrently', async () => {
    const cwdPaths = [
      '/workspaces/clone-a',
      '/workspaces/clone-b',
      '/workspaces/clone-c',
      '/workspaces/clone-d',
    ];
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'papercusp-su': {} },
        projects: { '/workspaces/existing': { marker: 'preserve' } },
      }),
    );

    await expect(Promise.all(cwdPaths.map((path) => ensureProjectTrust(home, path)))).resolves.toEqual([
      true,
      true,
      true,
      true,
    ]);

    const cfg = read();
    expect(cfg.mcpServers).toEqual({ 'papercusp-su': {} });
    expect(cfg.projects['/workspaces/existing']).toEqual({ marker: 'preserve' });
    for (const path of cwdPaths) {
      expect(cfg.projects[path]).toEqual({
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
        hasCompletedProjectOnboarding: true,
      });
    }
  });
});

describe('writeInteractiveClaudeConfig', () => {
  it('keys the dir by sid via the shared helper (launch ↔ resume agree)', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-abc', home });
    // The same path the wake-executor resume leg computes from coord_owner_id.
    expect(configDir).toBe(sessionClaudeConfigDir('su-abc'));
    expect(configDir).toBe(join(root, 'su-abc'));
  });

  it('symlinks the user config (creds / plugins / commands) — NOT a creds-only dir', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-1', home });
    for (const entry of ['.credentials.json', 'plugins', 'commands']) {
      const dest = join(configDir, entry);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(home, '.claude', entry));
    }
    // WI-3278: settings.json is a REAL MERGED file (not a symlink) — the user's
    // lock hooks carry over AND the bypassPermissions grant is baked in, so a
    // claude self-re-exec that drops the argv flags still boots in bypass mode.
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(false);
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toEqual([]);
    // WI-3280: the argv-drop recovery hook rides SessionStart in the same file.
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('session-recover-hook.mjs');
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(readFileSync(join(configDir, 'plugins', 'config.json'), 'utf8')).toContain('verdict');
  });

  it('scopes the exact task id to this session’s lifecycle hooks, not the user config', async () => {
    seedHome(home);
    const taskId = '0123456789abcdefghj';
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: "PAPERCUSP_SID='su-task' /hooks/lifecycle-report.sh" }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: "PAPERCUSP_SID='su-task' /hooks/lifecycle-report.sh" }] }],
        },
      }),
    );
    const { configDir } = await writeInteractiveClaudeConfig({
      sid: 'su-task', home, agentTaskId: taskId,
    });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    for (const event of ['SessionStart', 'SessionEnd']) {
      expect(settings.hooks[event][0].hooks[0].command)
        .toContain('PAPERCUSP_AGENT_TASK_ID=' + taskId);
    }
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).not.toContain(taskId);
  });

  it('WI-3278: the settings merge never writes THROUGH a pre-fix symlink into the global file', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-relink', home });
    // Simulate a pre-fix session dir: settings.json as a symlink to the global.
    rmSync(join(configDir, 'settings.json'));
    symlinkSync(join(home, '.claude', 'settings.json'), join(configDir, 'settings.json'));
    await writeInteractiveClaudeConfig({ sid: 'su-relink', home });
    // Session file is now real and carries the grant…
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('bypassPermissions');
    // …and the USER'S global settings.json was not mutated.
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).not.toContain('bypassPermissions');
  });

  it('EI-12086: bakes skipDangerousModePermissionPrompt so a headless member is not wedged on the claude 2.1.209 bypass-accept prompt', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-skip', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    // claude 2.1.209+ gates --dangerously-skip-permissions behind an interactive
    // "Bypass Permissions mode" accept prompt a headless member can never answer.
    // claude's gate is `!JG() && !accepted`, JG()=userSettings.skipDangerousModePermissionPrompt||…,
    // so this key short-circuits the prompt entirely. Baked into the session
    // settings (not relied on from the mutable global file).
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    // and it does NOT leak into the user's global settings.json.
    expect(
      readFileSync(join(home, '.claude', 'settings.json'), 'utf8'),
    ).not.toContain('skipDangerousModePermissionPrompt');
  });

  it('WI-6554700010009529: bakes the RTK hook-nag suppression into the session env, merged over the global env', async () => {
    seedHome(home);
    // A user global env must survive the merge.
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [] }, env: { USER_KEEP: 'yes' } }),
    );
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-rtk-env', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    // The egress-guard hook rewrites native Bash to RTK; without this RTK tells
    // the agent to run `rtk init -g`, which installs a competing hook.
    expect(settings.env).toEqual({ USER_KEEP: 'yes', ...RTK_SESSION_ENV });
    expect(settings.env.RTK_SUPPRESS_HOOK_WARNING).toBe('1');
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).not.toContain('RTK_SUPPRESS_HOOK_WARNING');
  });

  it('WI-6554700010009529: a global settings.json with no env still yields the RTK session env', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-rtk-env-bare', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.env).toEqual({ ...RTK_SESSION_ENV });
  });

  it('WI-6603: bakes the fleet-policy setting defaults every psu session inherits', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-policy', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    // Claude Code's stock default (true) injects a "# Git … Commit or push only
    // when the user asks. If on the default branch, branch first." block into every
    // agent's Bash tool description — the opposite of this repo's rule that
    // git-sync owns commit+push and the shared tree never branches.
    expect(settings.includeGitInstructions).toBe(false);
    // Stock default false makes the API return signature-only thinking blocks
    // (thinking: ''), so agent reasoning ingests as ZERO parts and is never
    // recallable via sessions:search.
    expect(settings.showThinkingSummaries).toBe(true);
    // /rewind restores files in place; this checkout is edited concurrently by the
    // whole fleet, so a rewind silently reverts peers' uncommitted work.
    expect(settings.fileCheckpointingEnabled).toBe(false);
    // None of it leaks into the user's global settings.json.
    const global = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    expect(global).not.toContain('includeGitInstructions');
    expect(global).not.toContain('showThinkingSummaries');
    expect(global).not.toContain('fileCheckpointingEnabled');
  });

  it('WI-6603: the policy defaults OVERRIDE a conflicting value in the global settings', async () => {
    seedHome(home);
    // A stale/personal global preference must not survive into a fleet session —
    // the policy layer is written after the global spread, so it wins.
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ includeGitInstructions: true, fileCheckpointingEnabled: true }),
    );
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-policy-override', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.includeGitInstructions).toBe(false);
    expect(settings.fileCheckpointingEnabled).toBe(false);
    expect(settings.showThinkingSummaries).toBe(true);
  });

  it('does NOT mirror the personal global memory (CLAUDE.md / AGENTS.md) — the P-002 / D-001 leak fix', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-iso', home });
    // The psu session must load NO personal memory: neither the CLAUDE.md
    // global-memory entrypoint nor its `@AGENTS.md` include target is present in
    // the config dir, so claude has no `$CLAUDE_CONFIG_DIR/CLAUDE.md` to auto-load.
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(configDir, 'AGENTS.md'))).toBe(false);
    // present() guards against a dangling symlink too — assert it's truly absent.
    expect(() => lstatSync(join(configDir, 'CLAUDE.md'))).toThrow();
    // But auth + hooks + tools still carry through (isolation is surgical, not a
    // creds-only strip): the personal-memory skip must not collateral-damage these.
    expect(lstatSync(join(configDir, '.credentials.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('PreToolUse');
  });

  it('pui-chat-first-ux P-007: a coding-assistant chat gets the personal memory; switching back to psu removes only our links', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-coding', home });
    syncPersonalClaudeMemory(configDir, true, home);
    // Like stock `claude`: the CLAUDE.md entrypoint and its `@AGENTS.md` target.
    expect(readlinkSync(join(configDir, 'CLAUDE.md'))).toBe(join(home, '.claude', 'CLAUDE.md'));
    expect(readFileSync(join(configDir, 'AGENTS.md'), 'utf8')).toContain('Personal rules');
    // An entry the user does not have stays absent (no dangling link).
    expect(() => lstatSync(join(configDir, 'CLAUDE.local.md'))).toThrow();
    // Idempotent on resume.
    syncPersonalClaudeMemory(configDir, true, home);
    expect(readlinkSync(join(configDir, 'CLAUDE.md'))).toBe(join(home, '.claude', 'CLAUDE.md'));

    // The psu persona never keeps them — but a real file someone put there is not ours.
    writeFileSync(join(configDir, 'CLAUDE.local.md'), 'session-local\n');
    syncPersonalClaudeMemory(configDir, false, home);
    expect(() => lstatSync(join(configDir, 'CLAUDE.md'))).toThrow();
    expect(() => lstatSync(join(configDir, 'AGENTS.md'))).toThrow();
    expect(readFileSync(join(configDir, 'CLAUDE.local.md'), 'utf8')).toBe('session-local\n');
    // The user's own files are untouched.
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
  });

  it('symlinks the sibling ~/.claude.json (user-level MCP + onboarding/trust carry through)', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-2', home });
    const dest = join(configDir, '.claude.json');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(home, '.claude.json'));
    expect(readFileSync(dest, 'utf8')).toContain('papercusp-su');
  });

  it('isolates projects/: a REAL dir, and the shared store’s transcript is NOT visible', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-3', home });
    const projects = join(configDir, 'projects');
    // A real directory, never a symlink to the shared store.
    expect(lstatSync(projects).isSymbolicLink()).toBe(false);
    expect(lstatSync(projects).isDirectory()).toBe(true);
    // The peer's transcript that exists in the shared ~/.claude/projects is NOT
    // reachable here — this session writes its own transcripts in isolation.
    expect(existsSync(join(projects, 'proj-hash', 'peer-uuid.jsonl'))).toBe(false);
  });

  it('cross-agent isolation: two sids get distinct dirs with independent transcript stores', async () => {
    seedHome(home);
    const a = (await writeInteractiveClaudeConfig({ sid: 'su-A', home })).configDir;
    const b = (await writeInteractiveClaudeConfig({ sid: 'su-B', home })).configDir;
    expect(a).not.toBe(b);
    // A writes a transcript; B must never see it (no cross-session bleed).
    writeFileSync(join(a, 'projects', 'a-session.jsonl'), '{"a":1}');
    expect(existsSync(join(b, 'projects', 'a-session.jsonl'))).toBe(false);
  });

  it('is idempotent — a re-materialize (the resume leg) never clobbers an existing transcript', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-4', home });
    // The session wrote a transcript after launch.
    writeFileSync(join(configDir, 'projects', 'live.jsonl'), '{"turn":1}');
    // Resume re-materializes the SAME dir — must be a no-op for projects/.
    const again = await writeInteractiveClaudeConfig({ sid: 'su-4', home });
    expect(again.configDir).toBe(configDir);
    expect(readFileSync(join(configDir, 'projects', 'live.jsonl'), 'utf8')).toBe('{"turn":1}');
    // The merged settings file still resolves with the grant (WI-3278 rewrites
    // it each materialize — never through a symlink, never broken).
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('bypassPermissions');
  });

  it('degrades gracefully when the source ~/.claude does not exist (fresh box)', async () => {
    // home has NO .claude / .claude.json seeded.
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-5', home });
    expect(existsSync(configDir)).toBe(true);
    // Still gets an isolated transcript store; just no symlinks to mirror.
    expect(lstatSync(join(configDir, 'projects')).isDirectory()).toBe(true);
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false);
    // WI-3278: the fresh Windows VM had no global settings.json — the session
    // must STILL get the bypassPermissions grant.
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('prunePlugins (context-trimming-tiers P-020): fleet members lose github/cloudflare/firecrawl + playwright, keep context7 + papercusp-su', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-prune', home, prunePlugins: true });
    // plugins/ is a REAL dir: children link through, the registry is filtered.
    const reg = JSON.parse(
      readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(reg.plugins)).toEqual(['context7@claude-plugins-official']);
    expect(readFileSync(join(configDir, 'plugins', 'config.json'), 'utf8')).toContain('verdict');
    // .claude.json is a filtered REAL copy: playwright gone, papercusp-su kept.
    const cj = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cj.mcpServers)).toEqual(['papercusp-su']);
    // Default (no prune) stays a symlink mirror with the full registry.
    const { configDir: fullDir } = await writeInteractiveClaudeConfig({ sid: 'su-full', home });
    const fullReg = JSON.parse(
      readFileSync(join(fullDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(fullReg.plugins)).toHaveLength(4);
  });
});

/**
 * WI-3280 — argv-proof playbook delivery. claude 2.1.x's self-re-exec
 * (relaunchInto → vge) rebuilds argv WITHOUT the original launch flags, so the
 * `--system-prompt-file` playbook is lost. The config dir parks a playbook
 * copy + a SessionStart hook that re-injects it when the live claude process's
 * argv no longer carries a *-system-prompt-file flag.
 */
describe('WI-3280: SessionStart playbook recovery', () => {
  /** The exact chain shapes seen live: hook ← sh ← claude ← psu.mjs. */
  const INTACT_CHAIN = [
    ['sh', '-c', 'node hook'],
    [
      '/home/papercup/.local/bin/claude',
      '--dangerously-skip-permissions',
      '--system-prompt-file',
      '/home/papercup/.papercusp/launch-context/session-2.md',
      '--exclude-dynamic-system-prompt-sections',
      '--session-id',
      '22fa0398-0e51-48b1-93cb-e7c8426064d1',
      '--permission-mode',
      'bypassPermissions',
    ],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const DROPPED_CHAIN = [
    ['sh', '-c', 'node hook'],
    ['/home/papercup/.local/bin/claude'], // the re-exec'd bare argv, verbatim from /proc
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const RESUME_RELAUNCH_CHAIN = [
    ['sh', '-c', 'node hook'],
    ['/home/papercup/.local/bin/claude', '--resume', '22fa0398-0e51-48b1-93cb-e7c8426064d1'],
    ['node', '/mnt/c/x/psu.mjs'],
  ];

  function runHook(configDir: string, chain: string[][], env: Record<string, string> = {}): string {
    return execFileSync(process.execPath, [join(configDir, RECOVER_HOOK)], {
      encoding: 'utf8',
      input: '{"session_id":"random-new-id","source":"startup"}',
      // PAPERCUSP_SID cleared: the test process's own psu identity would
      // otherwise mismatch the seeded intent sid and fire the P-007 rebind leg.
      // The operator URL is a refused port: a `startup` SessionStart bumps the
      // context epoch (P-005), and that must never reach the live operator.
      env: {
        ...process.env,
        PSU_RECOVER_TEST_CHAIN: JSON.stringify(chain),
        PAPERCUSP_SID: '',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
        ...env,
      },
    });
  }

  async function seedWithPlaybook(sid: string): Promise<string> {
    seedHome(home);
    const playbookSrc = join(home, 'playbook.md');
    writeFileSync(playbookSrc, '# SU engineer playbook\nA pot is the offline-first data substrate.\n');
    return (await writeInteractiveClaudeConfig({
      sid,
      home,
      recovery: { playbookPath: playbookSrc, nativeSessionId: '22fa0398-0e51-48b1-93cb-e7c8426064d1' },
    })).configDir;
  }

  it('parks the playbook copy + intent and writes the hook script', async () => {
    const configDir = await seedWithPlaybook('su-rec1');
    expect(readFileSync(join(configDir, RECOVER_PLAYBOOK), 'utf8')).toContain('A pot is');
    const intent = JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8'));
    expect(intent.sid).toBe('su-rec1');
    expect(intent.nativeSessionId).toBe('22fa0398-0e51-48b1-93cb-e7c8426064d1');
    expect(readFileSync(join(configDir, RECOVER_HOOK), 'utf8')).toContain('argvIntact');
    // The settings hook command points node at THIS session's hook script.
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    const cmd = JSON.stringify(settings.hooks.SessionStart);
    expect(cmd).toContain(join(configDir, RECOVER_HOOK));
    expect(cmd).toContain(JSON.stringify(process.execPath).slice(1, -1));
  });

  it('appends to (never replaces) existing global SessionStart hook groups', async () => {
    seedHome(home);
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
      }),
    );
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-rec2', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(JSON.stringify(settings.hooks.SessionStart[0])).toContain('user-hook');
    expect(JSON.stringify(settings.hooks.SessionStart[1])).toContain(RECOVER_HOOK);
  });

  it('a resume-path re-materialize WITHOUT recovery keeps the original parked playbook', async () => {
    const configDir = await seedWithPlaybook('su-rec3');
    await writeInteractiveClaudeConfig({ sid: 'su-rec3', home }); // wake-executor leg: no recovery opt
    expect(readFileSync(join(configDir, RECOVER_PLAYBOOK), 'utf8')).toContain('A pot is');
    expect(existsSync(join(configDir, RECOVER_INTENT))).toBe(true);
  });

  it('hook is SILENT when the claude ancestor still carries --system-prompt-file', async () => {
    const configDir = await seedWithPlaybook('su-rec4');
    expect(runHook(configDir, INTACT_CHAIN)).toBe('');
  });

  it('hook is SILENT when a structured engine manages the system prompt outside argv', async () => {
    const configDir = await seedWithPlaybook('su-rec-sdk');
    expect(runHook(configDir, DROPPED_CHAIN, { PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED: '1' })).toBe('');
  });

  it('hook injects the playbook when the claude ancestor lost its argv (the VM shape)', async () => {
    const configDir = await seedWithPlaybook('su-rec5');
    const out = JSON.parse(runHook(configDir, DROPPED_CHAIN));
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(ctx).toContain('SESSION RECOVERED');
    expect(ctx).toContain('su-rec5'); // identity from the intent file
    expect(ctx).toContain('22fa0398-0e51-48b1-93cb-e7c8426064d1'); // recorded native id
    expect(ctx).toContain('A pot is the offline-first data substrate'); // the playbook itself
    // EI-22197250733115758: the replacement process must not be reassured that
    // host-backed wake injection / self-compaction survived when the discovery
    // record is absent. The banner names both consequences and the live read.
    expect(ctx).toContain('NO LIVE MANAGED PSU-PTY HOST');
    expect(ctx).toContain('Direct wake injection and host-driven carry-respawn are unavailable');
    expect(ctx).toContain('compaction watchdog remains the fallback');
    expect(ctx).toContain('run loop:status');
  });

  it('hook injects on the --resume relaunch branch too (argv rebuilt without the prompt flag)', async () => {
    const configDir = await seedWithPlaybook('su-rec6');
    const out = JSON.parse(runHook(configDir, RESUME_RELAUNCH_CHAIN));
    expect(out.hookSpecificOutput.additionalContext).toContain('A pot is');
  });

  it('hook is SILENT when no playbook was parked (role/raw dirs stay inert)', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-rec7', home });
    expect(existsSync(join(configDir, RECOVER_PLAYBOOK))).toBe(false);
    expect(runHook(configDir, DROPPED_CHAIN)).toBe('');
  });

  // EI-13477: a same-pid self-relaunch (TUI re-exec / update relaunch) writes a
  // brand-new native session id that adv_sessions.session_id is never updated
  // to, so the server-side context-gauge kept anchoring to the dead pre-relaunch
  // transcript forever. The hook's own stdin carries the freshly re-exec'd
  // process's REAL session_id — report it into the same psu-pty respawn log a
  // wrapper-driven carry-respawn already writes, so resolveSessionRefReconciled
  // (compaction-usage.ts) picks it up on the very next context-gauge read.
  describe('EI-13477: self-relaunch reports its new native id into the psu-pty respawn log', () => {
    // Resolve the directory exactly as the generated hook does: the
    // PAPERCUSP_PSU_PTY_DIR pin (the vitest shim sets it to a temp dir) or the
    // host default — the same papercuspPtyPath() latestRespawnNativeId reads.
    function respawnLogPath(sid: string): string {
      return join(papercuspPtyPath(), `${sid.replace(/[^a-zA-Z0-9._-]/g, '_')}.events.jsonl`);
    }
    // Each case writes under a unique throwaway sid.
    function uniqueSid(label: string): string {
      return `su-rec-${label}-${process.pid}-${Math.floor(performance.now() * 1000)}`;
    }

    it('a dropped-argv relaunch appends a respawned/self-relaunch event carrying the LIVE session_id', async () => {
      const sid = uniqueSid('drop');
      const configDir = await seedWithPlaybook(sid);
      const logPath = respawnLogPath(sid);
      try {
        expect(existsSync(logPath)).toBe(false);
        runHook(configDir, DROPPED_CHAIN); // runHook's stdin session_id is "random-new-id"
        expect(existsSync(logPath)).toBe(true);
        const lines = readFileSync(logPath, 'utf8').trim().split('\n');
        const last = JSON.parse(lines[lines.length - 1]);
        expect(last.kind).toBe('respawned');
        expect(last.mode).toBe('self-relaunch');
        expect(last.nativeId).toBe('random-new-id');
        expect(typeof last.ts).toBe('string');
      } finally {
        rmSync(logPath, { force: true });
      }
    });

    it('the --resume relaunch branch reports too (argv rebuilt without the prompt flag)', async () => {
      const sid = uniqueSid('resume');
      const configDir = await seedWithPlaybook(sid);
      const logPath = respawnLogPath(sid);
      try {
        runHook(configDir, RESUME_RELAUNCH_CHAIN);
        const last = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').pop()!);
        expect(last.kind).toBe('respawned');
        expect(last.nativeId).toBe('random-new-id');
      } finally {
        rmSync(logPath, { force: true });
      }
    });

    it('an INTACT argv (no relaunch) never writes the respawn log', async () => {
      const sid = uniqueSid('intact');
      const configDir = await seedWithPlaybook(sid);
      const logPath = respawnLogPath(sid);
      runHook(configDir, INTACT_CHAIN);
      expect(existsSync(logPath)).toBe(false);
    });

    it('a relaunch with no parked playbook (raw/role dir) never writes the respawn log', async () => {
      seedHome(home);
      const sid = uniqueSid('noplaybook');
      const { configDir } = await writeInteractiveClaudeConfig({ sid, home });
      const logPath = respawnLogPath(sid);
      runHook(configDir, DROPPED_CHAIN);
      expect(existsSync(logPath)).toBe(false);
    });
  });
});

/**
 * compaction-continuity-hardening-2026-07-07 P-004 (implements WI-2537) — the
 * post-compaction continuity anchor. On SessionStart[source=compact] the SAME
 * generated hook injects the marker-aware recovery contract + the
 * volatile-claims checklist (static, operator-down-proof) and appends the carry
 * brief fetched live from /api/agent-mcp/session-recovery-brief (fail-soft).
 */
describe('P-004: SessionStart[source=compact] continuity anchor', () => {
  const INTACT_CHAIN = [
    ['sh', '-c', 'node hook'],
    [
      '/home/papercup/.local/bin/claude',
      '--system-prompt-file',
      '/home/papercup/.papercusp/launch-context/session-2.md',
    ],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const DROPPED_CHAIN = [
    ['sh', '-c', 'node hook'],
    ['/home/papercup/.local/bin/claude'],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  /** A refused-connection operator URL — port 1 is never listening. */
  const DEAD_OPERATOR = 'http://127.0.0.1:1';

  async function seedWithPlaybook(sid: string): Promise<string> {
    seedHome(home);
    const playbookSrc = join(home, 'playbook.md');
    writeFileSync(playbookSrc, '# SU engineer playbook\nA pot is the offline-first data substrate.\n');
    return (await writeInteractiveClaudeConfig({
      sid,
      home,
      recovery: { playbookPath: playbookSrc, nativeSessionId: '22fa0398-0e51-48b1-93cb-e7c8426064d1' },
    })).configDir;
  }

  /** Async runner — the stub-server test must keep the parent event loop free
   *  (execFileSync would block it and deadlock the child's fetch). Overrides
   *  PAPERCUSP_SID to '' so the hook resolves the owner from the parked intent
   *  file, not this test process's own psu identity. */
  function runHookAsync(
    configDir: string,
    chain: string[][],
    input: string,
    env: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [join(configDir, RECOVER_HOOK)],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PSU_RECOVER_TEST_CHAIN: JSON.stringify(chain),
            PAPERCUSP_SID: '',
            ...env,
          },
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin!.end(input);
    });
  }

  it('compact source: injects the static anchor + the fetched carry brief (owner from intent)', async () => {
    const configDir = await seedWithPlaybook('su-cmp1');
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          text: 'Armed loop @papercusp (active, every 120s). Its carry-note (written 5m ago):\n## Next action\nship P-004',
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const out = JSON.parse(
        await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"compact"}', {
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
        }),
      );
      const ctx = out.hookSpecificOutput.additionalContext as string;
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
      expect(ctx).toContain('⟦post-compaction-recovery⟧');
      expect(ctx).toContain('do not call coord:orient');
      expect(ctx).toContain('coord:declare-intent { intent, current_plan_slug, items }');
      expect(ctx).toContain('coord:orient { afterCompaction: true }');
      expect(ctx).toContain('exactly once only when the marker is absent');
      expect(ctx).not.toContain('run coord:orient { afterCompaction: true }');
      expect(ctx).toContain('HYPOTHESES to re-verify');
      // EI-10942: the anchor hands the successor a single batched ToolSearch so the
      // core deferred su tools reload in ONE round-trip instead of being rediscovered
      // call-by-call — and it must come BEFORE the coord:orient FIRST ACTION (coord:orient
      // is itself one of the deferred tools being preloaded).
      expect(ctx).toContain('TOOL PRELOAD');
      expect(ctx).toContain('select:mcp__papercusp-su__coord_orient');
      expect(ctx).toContain('mcp__papercusp-su__coord_declare_intent');
      expect(ctx).toContain('mcp__papercusp-su__work_items_checkpoint');
      expect(ctx.indexOf('TOOL PRELOAD')).toBeLessThan(ctx.indexOf('FIRST ACTION'));
      // turn-provenance P-004: native continuations are stamped machine-generated.
      expect(ctx).toContain('⟦turn-provenance⟧ MACHINE-GENERATED CONTINUATION');
      expect(ctx).toContain('Never attribute its text to the owner');
      expect(ctx).toContain('Armed loop @papercusp (active, every 120s)');
      expect(ctx).toContain('ship P-004');
      // argv intact ⇒ NO playbook-recovery part alongside the anchor.
      expect(ctx).not.toContain('SESSION RECOVERED');
      // The fetch carried the intent-file owner.
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('/api/agent-mcp/session-recovery-brief?owner=su-cmp1');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('P-005: startup/resume/clear each bump the context epoch ONCE and inject nothing extra', async () => {
    const configDir = await seedWithPlaybook('su-epoch1');
    const hits: Array<{ method: string; url: string }> = [];
    const server: Server = createServer((req, res) => {
      hits.push({ method: req.method ?? '', url: req.url ?? '' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, epoch: hits.length }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      for (const source of ['startup', 'resume', 'clear']) {
        const out = await runHookAsync(configDir, INTACT_CHAIN, JSON.stringify({ session_id: 'x', source }), {
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
        });
        // argv intact and no compaction: the bump is silent.
        expect(out).toBe('');
      }
      expect(hits.map((h) => h.method)).toEqual(['POST', 'POST', 'POST']);
      expect(hits.map((h) => h.url)).toEqual([
        '/api/agent-mcp/context-epoch-bump?owner=su-epoch1&source=startup',
        '/api/agent-mcp/context-epoch-bump?owner=su-epoch1&source=resume',
        '/api/agent-mcp/context-epoch-bump?owner=su-epoch1&source=clear',
      ]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('P-005: a startup bump with the operator DOWN still exits 0 and emits nothing', async () => {
    const configDir = await seedWithPlaybook('su-epoch2');
    const out = await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
      PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
    });
    expect(out).toBe('');
  });

  it('compact source with the operator DOWN: static anchor alone, exit 0 (fail-soft)', async () => {
    const configDir = await seedWithPlaybook('su-cmp2');
    const out = JSON.parse(
      await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
    expect(ctx).toContain('⟦post-compaction-recovery⟧');
    expect(ctx).toContain('do not call coord:orient');
    expect(ctx).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(ctx).toContain('coord:orient { afterCompaction: true }');
    expect(ctx).toContain('exactly once only when the marker is absent');
    expect(ctx).not.toContain('run coord:orient { afterCompaction: true }');
    // EI-10942: the tool-preload line is STATIC — it must land even with the operator
    // down (it needs no live data, and a blind post-compaction turn is exactly when a
    // degraded operator is most likely).
    expect(ctx).toContain('TOOL PRELOAD');
    expect(ctx).toContain('select:mcp__papercusp-su__coord_orient');
    expect(ctx).toContain('mcp__papercusp-su__coord_declare_intent');
    expect(ctx).not.toContain('carry brief (read live');
  });

  it('compact source + dropped argv: BOTH the playbook recovery and the anchor land, in that order', async () => {
    const configDir = await seedWithPlaybook('su-cmp3');
    const out = JSON.parse(
      await runHookAsync(configDir, DROPPED_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('SESSION RECOVERED');
    expect(ctx).toContain('A pot is the offline-first data substrate');
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
    expect(ctx.indexOf('SESSION RECOVERED')).toBeLessThan(ctx.indexOf('POST-COMPACTION CONTINUITY ANCHOR'));
  });

  it('compact source with an SDK-managed prompt skips duplicate playbook recovery but keeps the anchor', async () => {
    const configDir = await seedWithPlaybook('su-cmp-sdk');
    const out = JSON.parse(
      await runHookAsync(configDir, DROPPED_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
        PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED: '1',
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('SESSION RECOVERED');
    expect(ctx).not.toContain('A pot is the offline-first data substrate');
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
  });

  it('compact source with NO parked playbook (raw dir): the anchor still lands', async () => {
    seedHome(home);
    const { configDir } = await writeInteractiveClaudeConfig({ sid: 'su-cmp4', home });
    const out = JSON.parse(
      await runHookAsync(configDir, DROPPED_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
        PAPERCUSP_SID: 'su-cmp4',
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
    expect(ctx).not.toContain('SESSION RECOVERED');
  });

  it('startup source stays SILENT on the compact path (anchor is compact-gated)', async () => {
    const configDir = await seedWithPlaybook('su-cmp5');
    const out = await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
      PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
    });
    expect(out).toBe('');
  });
});

/**
 * compaction-continuity-hardening-2026-07-07 P-007 — identity durability across
 * relaunch. On EVERY SessionStart the generated hook compares the live
 * PAPERCUSP_SID against the sid recorded in the parked intent file; a mismatch
 * means every ownerId-keyed surface (armed loop, carry-note, claims, awaits,
 * fleet, held items) is stranded under a dead predecessor id. The hook
 * auto-rebinds via POST /api/agent-mcp/rebind-identity (then retires the old
 * sid in the intent file so later starts stay silent) and falls back to the
 * one-call coord:rebind-identity instruction when the operator refuses or is
 * unreachable. All fail-soft — a session start is never blocked.
 */
describe('P-007: SessionStart identity rebind (recorded sid ≠ live PAPERCUSP_SID)', () => {
  const INTACT_CHAIN = [
    ['sh', '-c', 'node hook'],
    [
      '/home/papercup/.local/bin/claude',
      '--system-prompt-file',
      '/home/papercup/.papercusp/launch-context/session-2.md',
    ],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const DEAD_OPERATOR = 'http://127.0.0.1:1';

  async function seedWithPlaybook(sid: string): Promise<string> {
    seedHome(home);
    const playbookSrc = join(home, 'playbook.md');
    writeFileSync(playbookSrc, '# SU engineer playbook\nA pot is the offline-first data substrate.\n');
    return (await writeInteractiveClaudeConfig({
      sid,
      home,
      recovery: { playbookPath: playbookSrc, nativeSessionId: '22fa0398-0e51-48b1-93cb-e7c8426064d1' },
    })).configDir;
  }

  function runHookAsync(
    configDir: string,
    chain: string[][],
    input: string,
    env: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [join(configDir, RECOVER_HOOK)],
        {
          encoding: 'utf8',
          env: { ...process.env, PSU_RECOVER_TEST_CHAIN: JSON.stringify(chain), PAPERCUSP_SID: '', ...env },
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin!.end(input);
    });
  }

  /** Stub operator that records rebind POSTs and answers with `response`. */
  function rebindServer(response: unknown) {
    const posts: Array<{ url: string; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        posts.push({ url: req.url ?? '', body: data });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response));
      });
    });
    return { posts, server };
  }

  it('auto-rebinds on mismatch, reports per-surface counts, and retires the old sid in the intent file', async () => {
    const configDir = await seedWithPlaybook('su-old-p7a');
    const { posts, server } = rebindServer({
      ok: true,
      from: 'su-old-p7a',
      to: 'su-new-p7a',
      surfaces: [
        { surface: 'loop-routine', moved: 1 },
        { surface: 'carry-note', moved: 2 },
        { surface: 'presence', moved: 0, dropped: 1 },
        { surface: 'awaits', moved: 0 },
      ],
      totalMoved: 4,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const env = { PAPERCUSP_SID: 'su-new-p7a', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}` };
      const out = JSON.parse(await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', env));
      const ctx = out.hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain('IDENTITY CHANGED ACROSS RELAUNCH');
      expect(ctx).toContain('su-old-p7a → live su-new-p7a');
      expect(ctx).toContain('AUTO-REBOUND');
      expect(ctx).toContain('loop-routine:1');
      expect(ctx).toContain('carry-note:2');
      expect(ctx).toContain('presence:1'); // dropped counts as handled
      expect(ctx).not.toContain('awaits:'); // zero-count surfaces stay out of the banner
      // The P-005 context-epoch bump shares this stub; count only the rebind.
      const rebinds = () => posts.filter((p) => p.url === '/api/agent-mcp/rebind-identity');
      expect(rebinds()).toHaveLength(1);
      expect(JSON.parse(rebinds()[0]!.body)).toEqual({ from: 'su-old-p7a', to: 'su-new-p7a' });
      // The bump runs AFTER the rebind, so it lands on the LIVE sid.
      expect(posts.map((p) => p.url)).toContain('/api/agent-mcp/context-epoch-bump?owner=su-new-p7a&source=startup');
      // The old sid is retired: the intent file now records the live id …
      const intent = JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8'));
      expect(intent.sid).toBe('su-new-p7a');
      expect(intent.nativeSessionId).toBe('22fa0398-0e51-48b1-93cb-e7c8426064d1');
      // … so the NEXT start is silent (no re-fire, no second rebind POST).
      expect(await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', env)).toBe('');
      expect(rebinds()).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('a REFUSED rebind (from appears live) requires verification and keeps the recorded sid', async () => {
    const configDir = await seedWithPlaybook('su-old-p7b');
    const { server } = rebindServer({ ok: false, refused: 'from_appears_live', surfaces: [], totalMoved: 0 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const out = JSON.parse(
        await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
          PAPERCUSP_SID: 'su-new-p7b',
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
        }),
      );
      const ctx = out.hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain('AUTO-REBIND REFUSED');
      expect(ctx).toContain('VERIFY FIRST');
      expect(ctx).toContain('coord:whoami');
      expect(ctx).toContain('coord:orient');
      expect(ctx).not.toContain('force:true');
      expect(ctx).not.toContain('NOW (it needs NO force');
      expect(JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8')).sid).toBe('su-old-p7b');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('operator DOWN: the one-call instruction still lands (fail-soft, exit 0), sid stays recorded', async () => {
    const configDir = await seedWithPlaybook('su-old-p7c');
    const out = JSON.parse(
      await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
        PAPERCUSP_SID: 'su-new-p7c',
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('unreachable for auto-rebind');
    expect(ctx).toContain('VERIFY FIRST');
    expect(ctx).toContain('coord:whoami');
    expect(ctx).toContain('coord:orient');
    expect(ctx).not.toContain('force:true');
    expect(JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8')).sid).toBe('su-old-p7c');
  });

  it('matching live + recorded sid stays SILENT (the common start)', async () => {
    const configDir = await seedWithPlaybook('su-same-p7d');
    const out = await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
      PAPERCUSP_SID: 'su-same-p7d',
      PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
    });
    expect(out).toBe('');
  });
});

/**
 * EI-12938 (owner-reported 2026-07-16): "psu --resume prompted me to login; I
 * exited the dialog, re-ran it, and then it was fine."
 *
 * The launch-READINESS contract. A session's CLAUDE_CONFIG_DIR is built by one
 * of three writers, and only `writeInteractiveClaudeConfig` yields a dir a HUMAN
 * can launch into:
 *   - `writeSpawnClaudeConfig(persistentDir)` — a bee/plan-run: creds symlink only;
 *   - `rematerializeSession` — an archived session restored: the transcript only;
 *   - the mirror — everything.
 * The first two have no `.claude.json`, and THAT (not `.credentials.json`, which
 * `psu --resume` already re-heals) is where claude keeps oauthAccount /
 * onboarding / trust / the user-level MCP servers. So an interactive resume of
 * such a dir boots the first-run wizard despite a healthy system login — and
 * then mints its own stub config, which is why the SECOND attempt stops
 * prompting while silently running with no MCP and no lock hooks.
 *
 * These pin: not-ready is DETECTED (incl. the stub — "it works now" is not
 * "it's fixed"), the repair produces a real launch-ready dir WITHOUT eating the
 * restored transcript, and a healthy dir is left alone (no re-link churn, no
 * un-pruning a context-trimmed member).
 */
describe('EI-12938: interactive resume needs a LAUNCH-READY config dir, not just a transcript', () => {
  // Every case starts from a realistic source HOME — the whole question is
  // whether the SESSION dir mirrors it.
  beforeEach(() => seedHome(home));

  /** The dir `rematerializeSession` leaves behind: the transcript, nothing else. */
  function seedRematerializedDir(sid: string): string {
    const dir = sessionClaudeConfigDir(sid);
    mkdirSync(join(dir, 'projects', 'proj-hash'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'proj-hash', 'restored-uuid.jsonl'), '{"restored":1}');
    return dir;
  }

  it('a rematerialized (transcript-only) dir is NOT ready — the exact repro', async () => {
    const dir = seedRematerializedDir('su-remat');
    expect(existsSync(join(dir, '.claude.json'))).toBe(false);
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(false);
  });

  it("a bee's creds-symlink-only dir (writeSpawnClaudeConfig shape) is NOT ready", async () => {
    const dir = sessionClaudeConfigDir('su-bee');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(home, '.claude', '.credentials.json'), join(dir, '.credentials.json'));
    // A VALID credential + no account state is precisely the trap: auth looks fine.
    expect(existsSync(join(dir, '.credentials.json'))).toBe(true);
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(false);
  });

  it('the stub .claude.json claude mints on a first-run boot is NOT ready (an account, but no MCP)', async () => {
    const dir = seedRematerializedDir('su-stub');
    // Verbatim shape of the file the owner's attempt-1 left behind: oauthAccount
    // present (so attempt 2 stops prompting), mcpServers absent (so it is a
    // TOOL-LESS session). Accepting this as "ready" is the subtler bug.
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.com' }, userID: 'abc' }),
    );
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(false);
  });

  it('ensure repairs a rematerialized dir into a launch-ready one — account state, hooks, MCP, transcript kept', async () => {
    const dir = seedRematerializedDir('su-fix');
    const { configDir, repaired } = await ensureInteractiveClaudeConfig({ sid: 'su-fix', home });
    expect(configDir).toBe(dir);
    expect(repaired).toBe(true);
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(true);
    // .claude.json — the file that gates the wizard AND carries the user-level
    // MCP servers — is linked to the user's real config.
    expect(lstatSync(join(dir, '.claude.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, '.claude.json'))).toBe(join(home, '.claude.json'));
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('papercusp-su');
    // The lock/coord hooks the shared tree depends on.
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks).toBeTruthy();
    // The credential symlink, resolving to the real login.
    expect(readlinkSync(join(dir, '.credentials.json'))).toBe(join(home, '.claude', '.credentials.json'));
    // The whole point of the resume: the restored transcript must survive the repair.
    expect(readFileSync(join(dir, 'projects', 'proj-hash', 'restored-uuid.jsonl'), 'utf8')).toBe('{"restored":1}');
    // …and stay ISOLATED — the repair must not re-link projects/ to the shared store.
    expect(existsSync(join(dir, 'projects', 'proj-hash', 'peer-uuid.jsonl'))).toBe(false);
  });

  it('ensure repairs the first-run stub too (so a "working" second attempt is not left tool-less)', async () => {
    const dir = seedRematerializedDir('su-stub2');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'o@e.com' } }));
    expect((await ensureInteractiveClaudeConfig({ sid: 'su-stub2', home })).repaired).toBe(true);
    expect(lstatSync(join(dir, '.claude.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('papercusp-su');
  });

  it('a healthy mirror is ready → ensure no-ops (byte-identical, no re-link churn)', async () => {
    await writeInteractiveClaudeConfig({ sid: 'su-healthy', home });
    const dir = sessionClaudeConfigDir('su-healthy');
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(true);
    const before = lstatSync(join(dir, '.claude.json')).mtimeMs;
    expect((await ensureInteractiveClaudeConfig({ sid: 'su-healthy', home })).repaired).toBe(false);
    expect(lstatSync(join(dir, '.claude.json')).mtimeMs).toBe(before);
  });

  it('a P-020 pruned fleet dir is ready → an ensure never silently UN-prunes it', async () => {
    await writeInteractiveClaudeConfig({ sid: 'su-pruned', home, prunePlugins: true });
    const dir = sessionClaudeConfigDir('su-pruned');
    const json = join(dir, '.claude.json');
    // The pruned copy is a REAL file (it lost write-passthrough on purpose) that
    // still carries mcpServers — complete, just filtered.
    expect(lstatSync(json).isSymbolicLink()).toBe(false);
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(true);
    expect((await ensureInteractiveClaudeConfig({ sid: 'su-pruned', home })).repaired).toBe(false);
    expect(lstatSync(json).isSymbolicLink()).toBe(false); // still pruned, not re-linked
    expect(JSON.parse(readFileSync(json, 'utf8')).mcpServers).not.toHaveProperty('playwright');
  });

  it('never throws on a hopeless dir — a launch must never fail on config repair', async () => {
    expect(await isInteractiveClaudeConfigReady('/nope/does/not/exist')).toBe(false);
    // A dangling .claude.json symlink (the source config was deleted under it).
    const dir = sessionClaudeConfigDir('su-dangle');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(home, 'gone.json'), join(dir, '.claude.json'));
    expect(await isInteractiveClaudeConfigReady(dir)).toBe(false);
    await expect(ensureInteractiveClaudeConfig({ sid: 'su-dangle', home })).resolves.toMatchObject({
      configDir: expect.any(String),
    });
  });
});

/**
 * EI-12938's ACTUAL regression class, pinned structurally.
 *
 * The repair was never the hard part — `writeInteractiveClaudeConfig` existed,
 * was correct, and was well tested. The bug was a MISSING CALL: the 2026-07-12
 * fix (psu-resume-relogin leg 2) was bolted onto ONE of `rematerializeSession`'s
 * callers — the HTTP route — so the desktop Resume console, which calls
 * `rematerializeSession` directly, kept handing humans a transcript-only dir and
 * kept sending them to a /login screen for four more days. No unit test could
 * have caught that: every unit involved was green.
 *
 * So this guard is about the SHAPE of the system, not a unit: every leg that
 * rematerializes a session INTO A DIR A HUMAN WILL LAUNCH must re-ensure it.
 * A new caller must be classified deliberately — interactive (call the ensure)
 * or not (say why here) — instead of silently inheriting the bug.
 */
describe('EI-12938: every INTERACTIVE rematerialize leg re-ensures the config dir', () => {
  const LIB = join(__dirname);

  /** Callers that DON'T need the ensure — each with the reason it is exempt. */
  const NON_INTERACTIVE = new Map<string, string>([
    [
      'events/await/wake-executor.ts',
      'headless bee wake: its dir is writeSpawnClaudeConfig\'s deliberately plugin-free ' +
        'isolation (the plugin-checkout-into-cwd defect). A full mirror there is WRONG.',
    ],
    [
      'endpoint-route/routes/harness/streams.ts',
      'read-only transcript follow for the UI: restores a file to TAIL it, never launches an agent. ' +
        '(WI-6581 moved the actual call into session-transcript-remat.ts — streams.ts now only ' +
        'names it in prose, so it no longer matches the call-shape filter below either way.)',
    ],
    [
      'session-transcript-remat.ts',
      'WI-6581: the carved-out keying layer behind streams.ts\'s read-only follow. Same exemption, ' +
        'same reason — it restores a transcript to RESOLVE AND TAIL a path, and returns that path ' +
        'to an SSE reader. No human ever launches into the root it restores to.',
    ],
    [
      'adv-agent-detail.ts',
      'WI-5226 (EI-308 gap 2): best-effort rematerialize purely so the agent DOSSIER\'s ' +
        '"exact resume: supported" indicator is accurate for an already-ENDED session — a ' +
        'read-side existence check + restore for display, never a launch. The actual resume ' +
        'launch (console-launcher.ts / adv/sessions.ts) rematerializes+ensures again on its ' +
        'own leg, already covered above.',
    ],
  ]);

  /** The definition site, not a caller. */
  const DEFINER = 'session-archive.ts';

  it('no rematerializeSession caller launches a human into an unensured dir', async () => {
    const found = execFileSync('grep', ['-rl', '--include=*.ts', 'rematerializeSession', LIB], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(LIB.length + 1))
      .filter((rel) => !rel.endsWith('.test.ts') && rel !== DEFINER);

    const unclassified: string[] = [];
    const missingEnsure: string[] = [];
    for (const rel of found) {
      const src = readFileSync(join(LIB, rel), 'utf8');
      // A real call, not a doc-comment mention (session-dir-gc.ts / this module
      // both reference it in prose only).
      if (!/rematerializeSession\w*\s*\(/.test(src)) continue;
      if (NON_INTERACTIVE.has(rel)) continue;
      if (/ensureInteractiveClaudeConfig/.test(src)) continue;
      // Known-interactive legs are named so a failure reads as a regression;
      // anything else is a NEW caller nobody classified.
      if (rel === 'console-launcher.ts' || rel === 'endpoint-route/routes/adv/sessions.ts') missingEnsure.push(rel);
      else unclassified.push(rel);
    }

    expect(
      missingEnsure,
      'These legs rematerialize a session into a dir a HUMAN then launches, but never call ' +
        'ensureInteractiveClaudeConfig — the exact EI-12938 regression: the transcript comes ' +
        'back, `.claude.json` does not, and claude boots its first-run /login wizard on a box ' +
        'that is perfectly logged in.',
    ).toEqual([]);

    expect(
      unclassified,
      'A NEW rematerializeSession caller appeared. Classify it: if a human launches into that ' +
        'dir, call ensureInteractiveClaudeConfig after the restore (see console-launcher.ts); ' +
        'if not (headless spawn / read-only follow), add it to NON_INTERACTIVE here WITH the ' +
        'reason. Do not just delete this assertion — inheriting EI-12938 silently is the failure ' +
        'mode it exists to stop.',
    ).toEqual([]);
  });

  it('the exempt legs are still exempt for the reason recorded (not quietly repurposed)', async () => {
    // wake-executor's exemption rests on it targeting a bee's OWN config dir.
    const wake = readFileSync(join(LIB, 'events/await/wake-executor.ts'), 'utf8');
    expect(wake).toMatch(/rematerializeSession\(\{ sourceKind: 'claude', sessionId: sid, targetRoot: cfgDir \}\)/);
    // The transcript-follow route's rests on it only ever taking a path to READ —
    // WI-6581 moved the restore itself into session-transcript-remat, so the
    // shape to pin is "the route consumes a resolved path and nothing else".
    // c8661b4793 moved that follow code from endpoint-route/routes/harness/streams.ts
    // into owner-sessions/timeline.ts verbatim; pin it where it now lives.
    const streams = readFileSync(join(LIB, 'owner-sessions/timeline.ts'), 'utf8');
    expect(streams).toMatch(/const r = await rematerializeTranscript\(key\);\s*\n\s*if \(r\.path\) path = r\.path;/);
    // session-transcript-remat's rests on the same thing one layer down: it
    // restores in order to RESOLVE a path, and hands that path back. If it ever
    // grows a launch/spawn leg, the exemption above stops being true.
    const remat = readFileSync(join(LIB, 'session-transcript-remat.ts'), 'utf8');
    expect(remat).toMatch(/export async function rematerializeTranscript/);
    expect(remat).not.toMatch(/\b(spawn|execFile|console-launcher|writeInteractiveClaudeConfig)\b/);
  });
});

describe('WI-10005232: bootstrap/resume config filesystem calls stay asynchronous', () => {
  it('has no synchronous node:fs calls reachable from the launch and resume entrypoints', () => {
    const sourcePath = join(__dirname, 'interactive-claude-config.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const syncFsLocals = new Set<string>();
    const syncFsNamespaces = new Set<string>();

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['fs', 'node:fs'].includes(statement.moduleSpecifier.text)
      ) {
        continue;
      }
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) syncFsNamespaces.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        syncFsNamespaces.add(clause.namedBindings.name.text);
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (imported.endsWith('Sync')) syncFsLocals.add(specifier.name.text);
        }
      }
    }

    const functions = new Map<string, ts.FunctionDeclaration>();
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        functions.set(statement.name.text, statement);
      }
    }

    const reachable = new Set<string>();
    const syncCalls: string[] = [];
    const visitFunction = (name: string): void => {
      const declaration = functions.get(name);
      if (!declaration?.body || reachable.has(name)) return;
      reachable.add(name);

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isIdentifier(callee)) {
            if (syncFsLocals.has(callee.text)) syncCalls.push(`${name} -> ${callee.text}`);
            if (functions.has(callee.text)) visitFunction(callee.text);
          } else if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            syncFsNamespaces.has(callee.expression.text) &&
            callee.name.text.endsWith('Sync')
          ) {
            syncCalls.push(`${name} -> ${callee.expression.text}.${callee.name.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration.body);
    };

    visitFunction('writeInteractiveClaudeConfig');
    visitFunction('ensureInteractiveClaudeConfig');

    expect([...reachable]).toEqual(
      expect.arrayContaining([
        'materializeInteractiveClaudeConfig',
        'isInteractiveClaudeConfigReady',
        'ensureOnboardingComplete',
        'ensureProjectTrust',
        'writeRecoveryArtifacts',
        'writeSessionSettings',
        'writePrunedPluginsDir',
        'writePrunedClaudeJson',
        'linkIntoAsync',
      ]),
    );
    expect(syncCalls).toEqual([]);
  });
});

/**
 * EI-20273348458054257 — the SessionStart recovery banner's identity claim.
 *
 * Two defects met here. (1) The banner asserted "coord/MCP identity is
 * unaffected" UNCONDITIONALLY on every self-relaunch, while a self-relaunch can
 * genuinely fork the coord identity — measured live: recorded su-9cf35961… →
 * live su-c6e0a56f…, with 12 ownerId-keyed surfaces (armed loop, carry-note,
 * fleet leadership, owner facts, read cursors) stranded under the dead id. An
 * agent told its identity is intact has no reason to check, so it proceeds as
 * its old self and is silently wrong about every ownerId-keyed read.
 *
 * (2) The whole hook ships as a TEMPLATE-LITERAL STRING (RECOVER_HOOK_SOURCE)
 * written out to a .mjs file, so a backslash must be DOUBLED to survive. `tsc`
 * cannot see inside a string — it type-checks the template, not the program the
 * template encodes — so a mis-escaped quote produces a syntactically BROKEN hook
 * that ships green. Nothing in this suite's prior tests parsed the emitted
 * source. The first test below closes that class for every future editor.
 */
describe('EI-20273348458054257 recovery-banner identity claim', () => {
  it('emits a hook whose source is valid JavaScript (guards the template-escaping class)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-hooksrc-'));
    const file = join(dir, 'session-recover-hook.mjs');
    try {
      writeFileSync(file, RECOVER_HOOK_SOURCE);
      // node --check is the ground truth for "will node actually load this hook".
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WI-6554700010018176: `--check` parses but never EVALUATES, so a name the
  // generator imports but the emitted file does not (papercuspPtyPath) passed
  // it while every real SessionStart died with a ReferenceError at load. The
  // hook runs standalone from the session config dir, so execute it per source.
  it.each(['startup', 'fork', 'resume', 'compact'])(
    'the emitted hook LOADS and exits 0 standalone on SessionStart[%s] (guards the unbound-identifier class)',
    (source) => {
      const dir = mkdtempSync(join(tmpdir(), 'pc-hookload-'));
      const file = join(dir, 'session-recover-hook.mjs');
      try {
        writeFileSync(file, RECOVER_HOOK_SOURCE);
        let stderr = '';
        try {
          execFileSync(process.execPath, [file], {
            encoding: 'utf8',
            input: JSON.stringify({ session_id: 'hookload-probe', source }),
            env: {
              ...process.env,
              PAPERCUSP_SID: '',
              PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
              PAPERCUSP_PSU_PTY_DIR: dir,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 20_000,
          });
        } catch (err) {
          stderr = String((err as { stderr?: unknown }).stderr ?? err);
        }
        expect(stderr).not.toMatch(/ReferenceError|TypeError|SyntaxError/);
        expect(stderr).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  /**
   * identityLine() is self-contained (reads only `intent` and process.env), so
   * it can be lifted out of the hook string and exercised directly. Testing the
   * REAL emitted text — not a copy — is the point: a copy would drift.
   */
  const runIdentityLine = (recordedSid: string | undefined, liveSid: string | undefined): string => {
    const m = RECOVER_HOOK_SOURCE.match(/function identityLine\(intent\) \{[\s\S]*?\n\}/);
    if (!m) throw new Error('identityLine() not found in RECOVER_HOOK_SOURCE');
    const fn = new Function('intent', 'process', `${m[0]}\nreturn identityLine(intent);`) as (
      intent: unknown,
      proc: unknown,
    ) => string;
    return fn({ sid: recordedSid }, { env: liveSid === undefined ? {} : { PAPERCUSP_SID: liveSid } });
  };

  it('REPORTS THE FORK, and requires verification before any repair, when the live sid differs', async () => {
    const line = runIdentityLine('su-OLD', 'su-NEW');
    expect(line).toMatch(/IDENTITY CHANGED/);
    expect(line).toContain('su-OLD');
    expect(line).toContain('su-NEW');
    expect(line).toContain('VERIFY FIRST');
    expect(line).toContain('coord:whoami');
    expect(line).toContain('coord:orient');
    expect(line).toContain('predecessor is dead');
    expect(line).not.toContain('coord:rebind-identity');
    expect(line).not.toContain('force:true');
    // ...and it must NOT still be claiming continuity.
    expect(line).not.toMatch(/is unaffected/);
  });

  it('does NOT assert coord/MCP continuity it never checked when the sids agree', async () => {
    const line = runIdentityLine('su-SAME', 'su-SAME');
    expect(line).toContain('su-SAME');
    // The regression itself: the old text asserted the coord/MCP identity was
    // "unaffected" — a claim about a surface this hook never reads.
    expect(line).not.toMatch(/coord\/MCP identity is unaffected/);
    // It may only claim what it actually compared, and must point at the
    // authoritative read that settles it.
    expect(line).toMatch(/MATCHES the live env value/);
    expect(line).toMatch(/coord:orient/);
  });

  it('stays honest when there is no recorded sid to compare', async () => {
    const line = runIdentityLine(undefined, 'su-NEW');
    expect(line).not.toMatch(/is unaffected/);
    expect(line).toContain('VERIFY FIRST');
    expect(line).toContain('coord:whoami');
    expect(line).toMatch(/coord:orient/);
  });

  it('stays honest when there is a recorded sid but no live sid', async () => {
    const line = runIdentityLine('su-OLD', undefined);
    expect(line).toContain('su-OLD');
    expect(line).toContain('no live PAPERCUSP_SID');
    expect(line).toContain('VERIFY FIRST');
    expect(line).toContain('coord:whoami');
    expect(line).toContain('coord:orient');
    expect(line).not.toContain('coord:rebind-identity');
  });

  it('stays honest when neither sid is available', async () => {
    const line = runIdentityLine(undefined, undefined);
    expect(line).toContain('No recorded or live PAPERCUSP_SID');
    expect(line).toContain('VERIFY FIRST');
    expect(line).toContain('coord:whoami');
    expect(line).toContain('coord:orient');
  });
});
