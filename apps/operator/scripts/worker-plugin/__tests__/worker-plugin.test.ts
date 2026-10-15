/**
 * worker-plugin.test.ts — shape-validation for the `papercusp-worker` Claude plugin
 * manifest (papercusp-worker-integration-2026-06-04, D-005, progressive packaging).
 *
 * This validates the manifest is schema-correct (valid JSON, required fields, the
 * hooks wire the worker scripts incl. the activity bridge). It does NOT exercise a
 * live `claude plugin install` — that, plus portable Cupboard distribution (D-008),
 * is the remaining distribution work documented in the bundle README.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));

describe('papercusp-worker plugin manifest', () => {
  it('has the required Claude plugin fields (kebab-case name + version + description)', () => {
    expect(manifest.name).toBe('papercusp-worker');
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/); // kebab-case identifier
    expect(typeof manifest.version).toBe('string');
    expect(typeof manifest.description).toBe('string');
  });

  it('declares its hooks via the ./hooks/hooks.json component path', () => {
    expect(manifest.hooks).toBe('./hooks/hooks.json');
  });

  it('does NOT declare a statusLine (Claude statuslines are user-settings only, not a plugin contribution)', () => {
    expect(manifest.statusLine).toBeUndefined();
  });
});

function commands(section: Array<{ hooks: Array<{ command: string }> }> | undefined): string[] {
  return (section ?? []).flatMap((e) => e.hooks.map((h) => h.command));
}

describe('papercusp-worker hooks.json', () => {
  it('wires the matcher-less PostToolBatch lock-release hook', () => {
    const batch = hooks.hooks.PostToolBatch as Array<{
      matcher?: string;
      hooks: Array<{ command: string }>;
    }>;
    expect(commands(batch)).toEqual([
      '${HOME}/.papercusp/hooks/cc/posttoolbatch-locks-release.sh',
    ]);
    expect(batch[0]?.matcher).toBeUndefined();
  });

  it('wires the lock + activity-bridge (coord-folding, EI-11405) PostToolUse hooks', () => {
    const post = commands(hooks.hooks.PostToolUse);
    expect(post.some((c) => c.includes('posttooluse-locks-release.sh'))).toBe(true);
    // The headline: the cross-CLI activity bridge, which also folds in the
    // coord:inbox PUSH (the separate posttooluse-coord-inbox.sh is retired).
    expect(post.some((c) => c.includes('posttooluse-activity-report.sh'))).toBe(true);
  });

  it('wires the lock-acquire + bash-gate PreToolUse hooks', () => {
    const pre = commands(hooks.hooks.PreToolUse);
    expect(pre.some((c) => c.includes('pretooluse-locks-acquire.sh'))).toBe(true);
    expect(pre.some((c) => c.includes('pretooluse-bash-resource-gate.sh'))).toBe(true);
  });

  // WI-1079034 — if you are here because you narrowed this matcher and this test
  // failed, know its SECOND consumer before you change the assertion. Firing on
  // every tool is what writes a `tool_invocations` row for a NATIVE tool call
  // (Bash/Read/Grep produce no MCP row of their own), and that row is the sole
  // reason `FleetPresenceRow.lastToolCallAt` — an MCP-only max() feeding
  // deriveMemberVerdict, delegated-spawn first-turn evidence, the unguarded-halt
  // rescue and fleet-idle-drain — stays fresh across a native-tool turn. Narrow
  // this and an agent working entirely in native tools reads as stalled to its
  // leader, which is a silent failure: nothing errors, the verdict just goes
  // wrong. (EI-21855682261256330 was filed as a bug against that field by an
  // agent who had not found this coupling, and was dropped as invalid.)
  it('the activity hook fires on EVERY tool (matcher "*")', () => {
    const activityEntry = (hooks.hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>)
      .find((e) => e.hooks.some((h) => h.command.includes('posttooluse-activity-report.sh')));
    expect(activityEntry?.matcher).toBe('*');
  });

  it('references the stable installed hook location for every hook (operator-dependent, fails open without it)', () => {
    const all = [...commands(hooks.hooks.PreToolUse), ...commands(hooks.hooks.PostToolUse)];
    expect(all.every((c) => c.includes('/.papercusp/hooks/cc/'))).toBe(true);
  });

  // WI-3164 rolled RTK out to the fleet as its own inline `rtk hook claude` entry.
  // WI-6554700010009291: Claude Code resolves several hooks that each return
  // updatedInput by completion order, so a separate RTK hook could race the
  // egress guard and drop its network sandbox. RTK now lives INSIDE the guard;
  // the guard must be the Bash entry's ONLY rewriter.
  it('wires RTK through the egress guard, the single Bash rewriter, alongside the deny-only resource gate', () => {
    const bashEntry = (hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>).find(
      (e) => e.matcher === 'Bash',
    );
    expect(bashEntry).toBeDefined();
    const cmds = bashEntry!.hooks.map((h) => h.command);
    expect(cmds.some((c) => c.includes('pretooluse-bash-resource-gate.sh'))).toBe(true);
    expect(cmds.filter((c) => c.includes('pretooluse-restricted-egress-guard.mjs'))).toHaveLength(1);
    const everyCommand = [...commands(hooks.hooks.PreToolUse), ...commands(hooks.hooks.PostToolUse)];
    expect(everyCommand.some((c) => /\brtk\b/.test(c))).toBe(false);
  });

  // EI-21971958067151594 — `capability:bash` is the SAME shell over MCP. A
  // native-only `Bash` matcher left it exempt from every deny in the gate
  // (measured 2026-08-31: `tauri-agent-tools dom` DENIED as Bash, RAN as
  // capability:bash against a foreign webview). The gate gets its OWN entry
  // rather than a widened `Bash` matcher because rtk — co-located in that entry
  // — REWRITES the payload it is handed, and its behaviour on an MCP envelope is
  // unknown; a safety gate must not drag a third-party rewriter along with it.
  it('covers the MCP shell (capability:bash) in a SEPARATE entry that excludes rtk', () => {
    const entries = hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const mcpEntry = entries.find((e) => e.matcher === 'mcp__.*__capability_bash');
    expect(mcpEntry, 'no PreToolUse entry covers mcp__*__capability_bash').toBeDefined();
    const cmds = mcpEntry!.hooks.map((h) => h.command);
    expect(cmds.some((c) => c.includes('pretooluse-bash-resource-gate.sh'))).toBe(true);
    expect(cmds.some((c) => c.includes('pretooluse-restricted-egress-guard.mjs') || /\brtk\b/.test(c))).toBe(false);
  });
});

/**
 * EI-9471 regression: rtk hijacked a scoped single-file `npx vitest run <file> | grep |
 * head` into a FULL-SUITE run (10k suites, 11MB) when its vitest output-parser failed on
 * the piped form — it dropped the file filter and re-synthesized an UNSCOPED run. RTK
 * must therefore never see a vitest command (fail-open: run verbatim, never a deny).
 * RTK now lives in the egress guard the Bash entry wires (WI-6554700010009291), so we
 * run THAT script — the repo copy of the file the plugin references — outside a psu
 * session (no PAPERCUSP_SID, so no operator call) against a hermetic fake `rtk` that
 * records each invocation, and assert vitest never reaches it while git status does.
 */
describe('papercusp-worker RTK rewrite — vitest skip (EI-9471)', () => {
  const GUARD = join(ROOT, '..', 'hooks', 'cc', 'pretooluse-restricted-egress-guard.mjs');

  it('the Bash entry references exactly this guard script', () => {
    const bashEntry = (hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>).find(
      (e) => e.matcher === 'Bash',
    );
    expect(bashEntry!.hooks.map((h) => h.command)).toContain(
      '${HOME}/.papercusp/hooks/cc/pretooluse-restricted-egress-guard.mjs',
    );
    expect(existsSync(GUARD)).toBe(true);
  });

  // Run the guard with a fake `rtk` named by PAPERCUSP_RTK_BIN; return whether rtk was
  // invoked (`rtk rewrite …`) and what the hook emitted on stdout.
  function runRtkHook(command: string): { stdout: string; rtkInvoked: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'rtk-guard-'));
    try {
      const marker = join(dir, 'invoked');
      const fakeRtk = join(dir, 'rtk');
      writeFileSync(
        fakeRtk,
        `#!/usr/bin/env bash\nif [ "$1" = "rewrite" ]; then printf X >> ${JSON.stringify(marker)}; echo "rtk $2"; exit 0; fi\nexit 64\n`,
      );
      chmodSync(fakeRtk, 0o755);
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
      const stdout = execFileSync(process.execPath, [GUARD], {
        input: payload,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', PAPERCUSP_RTK_BIN: fakeRtk },
      });
      return { stdout, rtkInvoked: existsSync(marker) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does NOT route a piped single-file vitest run through rtk (runs verbatim, filter preserved)', () => {
    const res = runRtkHook(
      'cd packages/operator-core && npx vitest run lib/agent-tools/coordination/presence-snapshot-targeted.test.ts 2>&1 | grep -A 30 "error when mocking" | head -50',
    );
    expect(res.rtkInvoked).toBe(false); // rtk never sees vitest → it cannot hijack it into a full-suite run
    expect(res.stdout.trim()).toBe(''); // no updatedInput emitted → Claude runs the original command verbatim
  });

  it('skips rtk for a bare (non-piped) vitest run too — any vitest form, not just the piped one', () => {
    const res = runRtkHook('npx vitest run some/file.test.ts');
    expect(res.rtkInvoked).toBe(false);
  });

  it('still routes a non-vitest command (git status) through rtk for compression', () => {
    const res = runRtkHook('git status');
    expect(res.rtkInvoked).toBe(true);
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'rtk git status' } },
    });
  });
});
