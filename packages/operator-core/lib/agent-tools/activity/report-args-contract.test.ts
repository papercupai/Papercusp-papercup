/**
 * Regression coverage for activity:report's failure-path argument guidance
 * (EI-22571277074273886).
 *
 * Adjacent activity tools use `ownerId` and `limit`, so callers can reasonably
 * carry those names into activity:report. The report surface intentionally
 * records one event and has no bounded-read argument; these redirects must
 * explain the distinction without adding aliases with different semantics.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';
import reportTool from './report';
import recentTool from './recent';

type ToolLike = {
  args: unknown;
  guidance?: { argRedirects?: Record<string, unknown> };
};

/** Walk through ZodEffects if the source schema gains a refinement later. */
function declaredKeys(tool: ToolLike): string[] {
  let node: unknown = tool.args;
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return Object.keys(shape);
    const def = (node as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    node = def?.schema ?? def?.innerType;
  }
  throw new Error("could not read activity:report's args schema");
}

const report = reportTool as unknown as ToolLike;
const reportKeys = declaredKeys(report);
const redirects = report.guidance?.argRedirects ?? {};

describe('activity:report hook fallback ingress', () => {
  const row = { eligible: 1, applied: 0, reason: 'lock-transport-unavailable', observed_at: '2026-10-12T11:00:00.000Z' };
  it('accepts only bounded measured lock outcomes without caller-supplied scope or authority', () => {
    expect(reportTool.args.safeParse({ agent: 'omp', hook_fallbacks: [row] }).success).toBe(true);
    expect(reportTool.args.safeParse({ hook_fallbacks: [{ ...row, applied: 1, reason: 'applied' }] }).success).toBe(true);
    for (const bad of [{ ...row, eligible: 2 }, { ...row, applied: 1 }, { ...row, reason: 'arbitrary' },
      { ...row, scope: 'another-owner' }, { ...row, workspaceId: 'another-workspace' },
      { ...row, mechanism: 'other' }, { ...row, observed_at: 'invalid' }]) {
      expect(reportTool.args.safeParse({ hook_fallbacks: [bad] }).success).toBe(false);
    }
    expect(reportTool.args.safeParse({ hook_fallbacks: Array(65).fill(row) }).success).toBe(false);
  });
});

describe('activity:report guidance.argRedirects (EI-22571277074273886)', () => {
  it('relocates ownerId to the declared owner key on the same tool', () => {
    const redirect = redirects.ownerId;
    expect(typeof redirect).toBe('string');

    const split = splitLocalSchemaTarget(redirect as string, reportKeys);
    expect(split, 'ownerId must be authored as `owner — explanation`').not.toBeNull();
    expect(split?.path).toBe('owner');
    expect(split?.note).toMatch(/rename/i);
    expect(reportKeys).toContain('owner');
    expect(reportKeys).not.toContain('ownerId');
    expect(reportTool.args.safeParse({ ownerId: 'su-example' }).success).toBe(false);
    expect(reportTool.args.safeParse({ owner: 'su-example' }).success).toBe(true);
  });

  it('routes limit to activity:recent and explains that reports have no limit', () => {
    const redirect = redirects.limit;
    expect(redirect).toMatchObject({
      tool: 'activity:recent',
      args: { limit: 50 },
      note: expect.stringMatching(/no `limit` argument/i),
    });

    const call = redirect as { tool: string; args: Record<string, unknown>; note: string };
    expect(call.note).toContain('activity:recent');
    expect(recentTool.args.safeParse(call.args).success).toBe(true);
    expect(reportKeys).not.toContain('limit');
    expect(reportTool.args.safeParse({ limit: 50 }).success).toBe(false);
  });
});

/**
 * EI-24022555028936462 (review-system-rework-reduction-2026-09-23 P-012): the Claude
 * hook sent `hook_bundle.glance_stale`, which ActivityHookBundleRequest declared but
 * this tool's zod schema did not, so the dispatch layer refused 622 of 1,269 hook
 * calls from one session as undeclared args. The class is hook/schema drift: a hook
 * learns a key the server schema never declared. This reads the keys the hooks
 * ACTUALLY SEND from their source and requires the schema to DECLARE each one.
 * safeParse alone is not enough: a non-strict object strips unknown keys and would
 * pass, while the dispatch layer's undeclared-arg check still refuses the call.
 */
describe('activity:report hook_bundle accepts every key the hooks send (EI-24022555028936462)', () => {
  const repoRoot = resolve(__dirname, '../../../../..');

  function objectShape(node: unknown): Record<string, unknown> {
    let cur: unknown = node;
    for (let hop = 0; hop < 8 && cur; hop += 1) {
      const shape = (cur as { shape?: Record<string, unknown> }).shape;
      if (shape && typeof shape === 'object') return shape;
      const def = (cur as { _def?: { schema?: unknown; innerType?: unknown } })._def;
      cur = def?.innerType ?? def?.schema;
    }
    throw new Error('could not reach a zod object shape');
  }

  const declared = Object.keys(objectShape(objectShape(reportTool.args).hook_bundle));

  function sentByClaudeHook(): string[] {
    const src = readFileSync(resolve(repoRoot, 'apps/operator/scripts/hooks/cc/posttooluse-activity-report.sh'), 'utf8');
    const keys = new Set<string>();
    for (const m of src.matchAll(/args\['hook_bundle'\]\['([a-z_]+)'\]/g)) keys.add(m[1]);
    const literal = src.match(/args\['hook_bundle'\]\s*=\s*\{([^}]*)\}/);
    if (literal) for (const m of literal[1].matchAll(/'([a-z_]+)'\s*:/g)) keys.add(m[1]);
    return [...keys];
  }

  function sentByOmpHook(): string[] {
    const src = readFileSync(resolve(repoRoot, 'apps/operator/scripts/hooks/omp/coord-hook.ts'), 'utf8');
    const start = src.indexOf("callMcpTool('activity:report'");
    expect(start, 'omp hook no longer calls activity:report by this literal; update this guard').toBeGreaterThan(-1);
    const open = src.indexOf('hook_bundle: {', start);
    expect(open).toBeGreaterThan(-1);
    const body = src.slice(open, src.indexOf('\n    },', open));
    return [...new Set([...body.matchAll(/(?:^|[\s{,(])([a-z][a-z_]*)\s*:/gm)].map((m) => m[1]))].filter((k) => k !== 'hook_bundle');
  }

  it('extracts the keys it guards (positive control, so an empty scan cannot pass)', () => {
    expect(sentByClaudeHook()).toEqual(expect.arrayContaining(['generation', 'glance_stale']));
    expect(sentByOmpHook()).toEqual(expect.arrayContaining(['generation', 'since_ts', 'force_resync']));
  });

  const undeclaredOf = (schemaKeys: string[]) =>
    [...new Set([...sentByClaudeHook(), ...sentByOmpHook()])].filter((k) => !schemaKeys.includes(k));

  it('declares every hook_bundle key the Claude and omp hooks send', () => {
    const undeclared = undeclaredOf(declared);
    expect(undeclared, `hook_bundle keys sent by a hook but not declared in report.ts: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('flags the pre-fix schema (control: the detector is falsifiable)', () => {
    // The schema as it stood before EI-24022555028936462: identical minus glance_stale.
    expect(undeclaredOf(declared.filter((k) => k !== 'glance_stale'))).toEqual(['glance_stale']);
  });

  it('accepts a glance-only request from the Claude hook', () => {
    const parsed = reportTool.args.safeParse({ owner: 'su-example', hook_bundle: { generation: 'g1', glance_stale: true } });
    expect(parsed.success).toBe(true);
    expect((parsed as { data?: { hook_bundle?: Record<string, unknown> } }).data?.hook_bundle?.glance_stale).toBe(true);
  });
});
