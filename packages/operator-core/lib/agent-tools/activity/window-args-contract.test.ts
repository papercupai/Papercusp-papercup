/**
 * window-args-contract.test.ts — the activity read PAIR's windowing/budget vocabulary,
 * derived from the live zod schemas rather than restated in prose.
 *
 * THE DEFECT THIS PINS (EI-22047814129755519 + EI-21837773431817305, filed independently
 * from opposite sides). `activity:recent` and `activity:tool-log` read the same activity
 * and window it with OPPOSITE vocabularies: `since_id` + `limit` here, `since`/`until` +
 * `max_lines`/`top_k` there. A caller moving between the two siblings is rejected in
 * BOTH directions, and the bare unrecognized-key message could only list accepted keys.
 *
 * WHY THE GUESS IS REASONABLE, AND WHY THAT MATTERS. `session_id` is spelled — and
 * bounded — identically in both, on purpose (see its `.describe()` in recent.ts). So a
 * caller has direct evidence from these very tools that they agree on arg names. The
 * divergence on time and budget args is therefore genuinely unpredictable from either
 * side, which is why the remedy is discoverability on the FAILURE path rather than more
 * prose in two descriptions that are already prompt-weight budgeted.
 *
 * WHY THIS IS NOT "FIXED" BY ACCEPTING THE KEYS. The vocabularies are not synonyms:
 * `since_id` is a monotonic ROW CURSOR and `since` is a wall-clock instant; `limit` is a
 * row count and `max_lines` is a display budget whose older entries decay out first.
 * Accepting each other's spellings would silently answer a different question than the
 * caller asked — exactly the undeclared-arg hazard the strict-args rail exists to
 * prevent. So the fix is a redirect, and this test keeps the redirects honest.
 *
 * WHY IT ASSERTS THE RENDER, NOT JUST THE PRESENCE (plan D-004). The renderer has only
 * two shapes: a local relocation ("pass it as `x` instead: note") when the target names
 * a declared key of THIS tool, and otherwise "`k` is not an arg of this tool — it is
 * written by <target>". A prose target carrying its own em-dash silently takes the
 * second branch, telling a caller who used the wrong key on the RIGHT tool that some
 * other tool owns their data. A presence-only assertion passes on that mis-authored
 * target, so presence is not what needs pinning.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/activity/window-args-contract.test.ts
 */
import { describe, expect, it } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';
import recentTool from './recent';
import toolLogTool from './tool-log';

type ToolLike = {
  name: string;
  args?: unknown;
  guidance?: { argRedirects?: Record<string, unknown> };
};

/** `.refine()`/`.superRefine()` wrap a ZodObject in ZodEffects, so `.shape` can be one or
 *  more `_def` hops down. Walk rather than assume today's depth — either tool is free to
 *  gain a cross-field refinement without silently turning this test into a no-op. */
function argKeys(tool: ToolLike): string[] {
  let node: unknown = tool.args;
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return Object.keys(shape).sort();
    const def = (node as { _def?: { schema?: unknown; innerType?: unknown; options?: unknown[] } })._def;
    if (Array.isArray(def?.options)) {
      const unionKeys = def.options.flatMap((option) => {
        const shape = (option as { shape?: Record<string, unknown> }).shape;
        return shape ? Object.keys(shape) : [];
      });
      if (unionKeys.length > 0) return [...new Set(unionKeys)].sort();
    }
    node = def?.schema ?? def?.innerType;
  }
  throw new Error(`could not read an object shape from ${tool.name}'s args schema`);
}

const recentKeys = argKeys(recentTool as ToolLike);
const toolLogKeys = argKeys(toolLogTool as ToolLike);

describe('activity read pair — the divergence these redirects exist for', () => {
  it('still spells session_id identically, which is why the other divergences surprise', () => {
    // The premise of both filings. If this ever stops holding, the redirects below are
    // arguing from a parity that no longer exists and their notes need rewording.
    expect(recentKeys).toContain('session_id');
    expect(toolLogKeys).toContain('session_id');
  });

  it('windows and budgets with genuinely disjoint vocabularies', () => {
    // recent: row cursor + row count. tool-log: wall clock + display budget.
    expect(recentKeys).toContain('since_id');
    expect(recentKeys).toContain('limit');
    expect(recentKeys).not.toContain('since');
    expect(recentKeys).not.toContain('until');

    expect(toolLogKeys).toContain('since');
    expect(toolLogKeys).toContain('until');
    expect(toolLogKeys).toContain('max_lines');
    expect(toolLogKeys).not.toContain('limit');
    expect(toolLogKeys).not.toContain('tool');
  });
});

describe('activity:recent guidance.argRedirects (EI-22047814129755519)', () => {
  const redirects = recentTool.guidance?.argRedirects ?? {};

  it('describes since_id as an unsigned decimal row-ID cursor rather than a timestamp', () => {
    expect(recentTool.description).toContain('unsigned decimal activity-row ID cursor');
    expect(recentTool.description).toContain('not a timestamp');
    expect(recentTool.guidance?.when).toContain('unsigned decimal activity-row ID');
    expect(recentTool.guidance?.when).toContain('activity:tool-log');
    expect(recentTool.args.shape.since_id.description).toContain('Unsigned decimal activity-row ID cursor');
    expect(recentTool.args.safeParse({ since_id: '2026-10-10T05:11:05.418Z' }).success).toBe(false);
    expect(recentTool.args.safeParse({ since_id: '1791612265418' }).success).toBe(true);
  });

  it('relocates `since` to the declared since_id and names the wall-clock alternative', () => {
    const split = splitLocalSchemaTarget(redirects.since as string, recentKeys);
    // Null here is the D-004 defect: the caller is on the right tool and would be told
    // another tool owns their value.
    expect(split, '`since` must be authored as `since_id — explanation`').not.toBeNull();
    expect(split?.path).toBe('since_id');
    // Renaming alone answers "page forward"; it does NOT answer "give me a time window",
    // so the note has to name the sibling or it silently misleads half the callers.
    expect(split?.note).toContain('activity:tool-log');
  });

  it('sends `until` cross-tool, because there is no upper bound here to rename it to', () => {
    // Asserted as a distinct SHAPE from `since` on purpose: the honest remedy differs,
    // and collapsing both into a rename would invent a capability this tool lacks.
    expect(redirects.until).toMatchObject({
      tool: 'activity:tool-log',
      note: expect.stringContaining('upper time bound'),
    });
    expect(recentKeys).not.toContain('until');
  });

  it('does not accept the redirected keys as real args', () => {
    // Guards the "fix" where someone silences the rejection by declaring the key, which
    // would answer a clock question with a row cursor.
    expect(recentTool.args.safeParse({ since: '2026-09-05T00:00:00.000Z' }).success).toBe(false);
    expect(recentTool.args.safeParse({ until: '2026-09-05T00:00:00.000Z' }).success).toBe(false);
  });
});

describe('activity:tool-log guidance.argRedirects (EI-21837773431817305)', () => {
  const redirects = toolLogTool.guidance?.argRedirects ?? {};

  it('relocates `limit` to max_lines and says dropping it takes the default budget', () => {
    const split = splitLocalSchemaTarget(redirects.limit as string, toolLogKeys);
    expect(split, '`limit` must be authored as `max_lines — explanation`').not.toBeNull();
    expect(split?.path).toBe('max_lines');
    expect(split?.note).toMatch(/rename/i);
    // The load-bearing half: dropping `limit` SUCCEEDS with the default 40 lines, so the
    // caller never learns they were refused anything.
    expect(split?.note).toMatch(/default 40/i);
  });

  it('relocates `ownerId` to owner as a pure rename, and says dropping it is refused', () => {
    // EI-21149038705756492. `ownerId` and `limit` arrived in ONE rejection; only `limit`
    // was repaired, so the filing stayed open against a tool that already looked fixed.
    // This pins the half that was missed.
    const split = splitLocalSchemaTarget(redirects.ownerId as string, toolLogKeys);
    expect(split, '`ownerId` must be authored as `owner — explanation`').not.toBeNull();
    expect(split?.path).toBe('owner');
    expect(split?.note).toMatch(/rename/i);

    // The asymmetry with `limit` is the load-bearing part: dropping `limit` silently
    // succeeds on the default budget, whereas dropping `ownerId` is REFUSED outright.
    // A caller told only "rename it" may reasonably just omit it instead.
    expect(split?.note).toMatch(/scope_required/i);
    expect(split?.note).toContain('session_id');

    // 'self' is the affordance a caller holding a coord-shaped `ownerId` least expects.
    expect(split?.note).toContain("'self'");
  });

  it('sends `tool` cross-tool rather than authoring a prose "drop the key" string', () => {
    // A plain string here would carry its own em-dash, split on it, fail the path regex,
    // and render "…it is written by <the tail of the sentence>". The object form makes
    // the renderer's fixed "it is written by X" sentence read correctly.
    expect(redirects.tool).toMatchObject({
      tool: 'activity:recent',
      args: expect.objectContaining({ kind: 'tool' }),
    });
    expect(splitLocalSchemaTarget(String((redirects.tool as { tool: string }).tool), toolLogKeys))
      .toBeNull();
  });

  it('does not accept the redirected keys as real args', () => {
    expect(toolLogTool.args.safeParse({ limit: 20 }).success).toBe(false);
    expect(toolLogTool.args.safeParse({ tool: 'work_items:get' }).success).toBe(false);
    // Guards the "fix" where someone silences the rejection by declaring `ownerId`
    // alongside `owner`, giving the tool two spellings for one scope.
    expect(toolLogTool.args.safeParse({ ownerId: 'su-9f0de' }).success).toBe(false);
    // Calibration: the key it redirects TO must actually parse, or the assertions above
    // would pass just as well against a tool whose whole schema rejects everything.
    expect(toolLogTool.args.safeParse({ owner: 'self' }).success).toBe(true);
  });
});
