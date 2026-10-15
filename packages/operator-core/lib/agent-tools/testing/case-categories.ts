/**
 * testing:case-categories — derived per-case categories plus the uncovered live surfaces.
 * Plan test-rubric-unification-2026-10-12 P-003 / R-3.
 *
 * A pure read. Every value is computed from its source record by
 * lib/testing-case-categories.ts at call time; no category is stored anywhere.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readTestCaseCategories } from '../../testing-case-categories';

export default defineTool({
  name: 'testing:case-categories',
  description:
    'Per-test-case categories derived at read time from their sources: layer (file path), subsystem (testing domain registry), surfaces (coverage evidence), citations (rubric tests checks and spec evidence bindings), cost p50/p95 and flakiness (recorded case results). Also lists the live testing_surfaces no recorded case covers. Read-only; no label is stored.',
  guidance: {
    when: 'You need what a test case covers, who cites it, what it costs or how flaky it is, or which live surfaces have no recorded test case.',
    notWhen: 'File-level flake ranking (testing:flakiness) or raw per-run case rows (testing:runs { cases: true }).',
    chaining: 'Pass files to scope one area. When truncatedByLimit is true, counts are floors, not totals.',
  },
  capability: 'operator:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    files: z
      .array(z.string().min(1).max(500))
      .max(50)
      .optional()
      .describe('repo-relative test files; omit for every file with recorded cases'),
    lookbackDays: z.number().int().min(1).max(90).optional().describe('default 14'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('max cases returned (default 25); casesTotal reports the full count'),
    uncoveredLimit: z
      .number()
      .int()
      .min(0)
      .max(200)
      .optional()
      .describe('max uncovered surfaces listed (default 25); the total is always reported'),
  }),
  async handler(args, ctx) {
    const result = await readTestCaseCategories({
      workspaceId: ctx.workspaceId ?? null,
      files: args.files,
      lookbackDays: args.lookbackDays,
      limit: args.limit,
      uncoveredLimit: args.uncoveredLimit,
    });
    return { data: { ok: true, ...result } };
  },
});
