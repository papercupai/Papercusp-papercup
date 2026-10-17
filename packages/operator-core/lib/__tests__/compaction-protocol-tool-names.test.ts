/**
 * Guard: the agent-facing compaction protocol must name the REAL tool and its REAL arg.
 *
 * EI-23785216218885104 (+ EI-23739936965956959): `apps/operator/prompts/papercusp-compaction.protocol.md`
 * — projected into every su/fleet agent's system prompt — told agents to call
 * `set_compaction_limit { tokens }`. The tool is `config:set-compaction-limit { limit }`, so each
 * agent that followed the prompt literally was refused `invalid_input` (`Unrecognized keys:
 * "tokens", "reason"`) and the telemetry watchdog filed one change-row per occurrence.
 *
 * Why the sibling `prompt-blueprint-verb-catalog.test.ts` did not catch it: that lint is
 * deliberately SURFACE-PRECISE for colon-form verbs in imperative shapes ("call `a:b`"); an
 * underscore-form name with a brace-args suffix is outside its grammar. This pin is the narrow
 * complement for the one protocol doc that carries a tool call + arg contract in prose.
 *
 * The tool's name and arg are READ FROM ITS SOURCE rather than hard-coded here, so renaming the
 * tool or its argument fails this test and forces the prompt to be updated with it.
 *
 * Run: testing:run { files: ['packages/operator-core/lib/__tests__/compaction-protocol-tool-names.test.ts'] }
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../../');

const PROTOCOL = readFileSync(join(REPO, 'apps/operator/prompts/papercusp-compaction.protocol.md'), 'utf8');
const TOOL_SRC = readFileSync(
  join(REPO, 'packages/operator-core/lib/agent-tools/config/set-compaction-limit.ts'),
  'utf8',
);

/** The tool's registered name, read from its `defineTool({ name })`. */
const toolName = /\bname:\s*'([^']+)'/.exec(TOOL_SRC)?.[1];
/** The first key of its zod `args: z.object({ <key>: ...` — the required token-count argument. */
const argKey = /args:\s*z\.object\(\{\s*(\w+):/.exec(TOOL_SRC)?.[1];

describe('papercusp-compaction.protocol.md names the real set-compaction-limit contract', () => {
  it('calibration: the instrument can read the tool name and its first arg from source', () => {
    // If either extraction returns undefined the assertions below would compare against
    // `undefined` and pass vacuously — fail LOUD instead.
    expect(toolName).toBe('config:set-compaction-limit');
    expect(argKey).toBe('limit');
  });

  it('calls the tool by its registered name with its real arg key', () => {
    expect(PROTOCOL).toContain(`\`${toolName} { ${argKey} }\``);
  });

  it('states the real clamp and force-respawn numbers (WI-6554700010016934)', () => {
    // The prompt said `L × 1.25` / "125% of L" while the code clamps at COMPACTION_OVERSHOOT_FACTOR
    // and forces at FORCE_COMPACT_FRACTION — a number that matched neither. Both are READ FROM
    // SOURCE so changing a constant fails this test until the prompt is updated with it.
    const constantsSrc = readFileSync(join(REPO, 'packages/operator-core/lib/agent-config-constants.ts'), 'utf8');
    const watchdogSrc = readFileSync(
      join(REPO, 'packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts'),
      'utf8',
    );
    const overshoot = /export const COMPACTION_OVERSHOOT_FACTOR = ([\d.]+);/.exec(constantsSrc)?.[1];
    const force = /const FORCE_COMPACT_FRACTION = ([\d.]+);/.exec(watchdogSrc)?.[1];
    const overLimit = /const OVER_LIMIT_FRACTION = ([\d.]+);/.exec(watchdogSrc)?.[1];
    // Calibration: an extraction miss would compare against `undefined` — fail loud instead.
    expect(overshoot).toMatch(/^\d+(\.\d+)?$/);
    expect(force).toMatch(/^\d+(\.\d+)?$/);
    expect(overLimit).toMatch(/^\d+(\.\d+)?$/);
    // Prose wraps across lines, so compare against whitespace-normalised text.
    const flat = PROTOCOL.replace(/\s+/g, ' ');
    const pct = (s: string) => `${Math.round(Number(s) * 100)}% of L`;
    expect(flat).toContain(`\`L × ${Number(overshoot)}\``);
    expect(flat).toContain(`Aim not to exceed ${pct(overshoot!)}`);
    expect(flat).toContain(`warns at ${pct(overLimit!)}`);
    expect(flat).toContain(`force-respawns at ${pct(force!)}`);
    expect(flat).not.toMatch(/1\.25|125%/);
  });

  it('does not carry the retired underscore spelling or the invented `tokens` arg', () => {
    // `set_compaction_limit` is the pre-registration spelling; `{ tokens }` was never an arg.
    // Both are strings an agent will copy verbatim into a tool call.
    expect(PROTOCOL).not.toMatch(/set_compaction_limit/);
    expect(PROTOCOL).not.toMatch(/\{\s*tokens\s*\}/);
  });
});
