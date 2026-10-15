/**
 * `code:pack` — the registered surface of the pinned packing leg (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-016; D-005, D-040).
 *
 * Named for the JOB (package evidence) rather than the binary, like its
 * siblings: `lsp:query` is type truth, `gitnexus.query` is topology,
 * `code:structural` is shape, this is evidence-for-a-reader.
 *
 * One tool over two engines on purpose. The engine is a consequence of the op —
 * `pack` is repomix, `diff` is code2prompt — because the choice turns on a
 * property the caller should not have to know: only repomix has a secret
 * scanner. Exposing two tools would invite picking the one without one.
 *
 * ⚠ The response shape lives in `guidance.returns`, NOT in `description`. The
 * prompt-weight budget counts description + when/notWhen/chaining and excludes
 * returns/seeAlso, so documenting the payload here would spend fleet-wide
 * system-prompt budget on something a caller only needs after it has already
 * chosen this tool.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { PACK_TEMPLATES, nativeChangeReport, packerFacade, type PackTemplate } from '../../code-intelligence/packer-facade.ts';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';
import locksQueue from '../locks/queue';

const TEMPLATES = Object.keys(PACK_TEMPLATES) as [PackTemplate, ...PackTemplate[]];

export default defineTool({
  name: 'code:pack',
  description:
    'Package code with pinned Repomix/code2prompt. pack selects include; diff packs changes or, with explain, returns a bounded native report of compiler consumers, tests, ownership and source/runtime freshness. Read-only; packs go to scratch. Only pack secret-scans; diff uses the deny-set.',
  guidance: {
    when: 'Need a scoped subsystem document for review, audit, or refactor; use `diff` for changed code only.',
    notWhen:
      `Packing follows retrieval: use lsp:query, gitnexus.query, code:structural, or ${RIPGREP_SCOPE_GUIDANCE} first, then pack the measured radius.`,
    chaining:
      'gitnexus.query → code:pack include:<radius>; cite provenance.commit + dirty.',
    returns:
      '{ answer, artifact } for packing, or { answer, report, ownership } for diff with explain. report cites changed source excerpts and current compiler consumers, identifies related tests and evidence to recheck, and compares previousFingerprint before pre-edit/pre-review. report.bundle joins bounded literal source, versioned symbols and paths with original edge provenance, coverage, token measurements and omitted counts; bundle.expansion reads the hash-bound captured detail without rerunning on newer source. limitations explicitly preserve bounded/static coverage. ownership is the current file-lock census, not permanent ownership; an unavailable read is unknown. Runtime build and compiler source identities are separate. artifact.path holds full packs with bounded preview and engine/version, commit/dirty/base, include/deny-set, fileCount, securityScan and capture provenance; null fileCount means unparsed selection. Refusals remain answer.error, never trustworthy empty.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  timeoutSec: 200,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z
      .enum(['pack', 'diff'])
      .describe('pack = the matching files (Repomix). diff = what changed (code2prompt). Neither writes.'),
    include: z
      .array(z.string().min(1))
      .min(1)
      .describe('REQUIRED glob set, e.g. ["packages/operator-core/lib/scheduler/**"]. A pattern starting with "-" is refused.'),
    ignore: z
      .array(z.string().min(1))
      .optional()
      .describe('Extra excludes. Appended to a non-overridable secret deny-set (.env, keys, credentials), never replacing it.'),
    format: z
      .enum(['markdown', 'xml'])
      .optional()
      .describe('Document format. Defaults to xml for pack, markdown for diff.'),
    template: z
      .enum(TEMPLATES)
      .optional()
      .describe('Prepend a reviewer framing: code-review | security-audit | refactor-prep | none.'),
    baseRef: z
      .string()
      .min(1)
      .optional()
      .describe('diff only: ref to diff against, e.g. "origin/main". Omitted = the working-tree diff.'),
    compress: z
      .boolean()
      .optional()
      .describe('pack only: collapse bodies to signatures. Much smaller; loses implementation detail.'),
    rootPath: z.string().min(1).optional().describe('Project root override. Defaults to the agent workspace root.'),
    explain: z.object({
      symbol: z.string().regex(/^[A-Za-z_$][\w$]*$/),
      file: z.string().min(1),
      line1: z.number().int().positive().optional(),
      paths: z.array(z.string().min(1)).max(50).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      phase: z.enum(['pre-edit', 'pre-review']).optional(),
      previousFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).optional().describe('diff only: bounded native change report with current compiler consumers, tests, source/runtime provenance, ownership and freshness. Re-submit previousFingerprint before editing or reviewing.'),
  }),
  result: z.object({ answer: z.unknown().optional(), artifact: z.unknown().optional() }).passthrough(),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    if (args.explain) {
      if (args.op !== 'diff') throw new Error('explain is supported only by op:diff.');
      const result = await nativeChangeReport({ include: args.include, rootPath: root, baseRef: args.baseRef }, args.explain);
      const paths = [...new Set([args.explain.file, ...result.report.changed.map(file => file.path),
        ...result.report.consumers.map(site => site.path)])].slice(0, 50);
      let ownership: { status: 'measured' | 'unknown'; paths: string[]; holders?: unknown[]; error?: string };
      try {
        const response = await locksQueue.handler({ paths, coordination_domain: root }, ctx);
        const parts = 'content' in response && Array.isArray(response.content) ? response.content : [];
        const textPart = parts.find(part => part.type === 'text');
        const data = JSON.parse(textPart && 'text' in textPart && typeof textPart.text === 'string' ? textPart.text : '{}');
        ownership = Array.isArray(data.active_locks)
          ? { status: 'measured', paths, holders: data.active_locks.map((lock: Record<string, unknown>) => ({
            path: lock.path, owner: lock.owner, intent: lock.intent, expiresAt: lock.expires_ts,
          })) }
          : { status: 'unknown', paths, error: data.error ?? 'Ownership read did not return a lock census.' };
      } catch (error) { ownership = { status: 'unknown', paths, error: error instanceof Error ? error.message : String(error) }; }
      return { data: { ...result, ownership } };
    }
    const result = await packerFacade(args.op, {
      include: args.include,
      ignore: args.ignore,
      rootPath: root,
      format: args.format,
      template: args.template,
      baseRef: args.baseRef,
      compress: args.compress,
    });
    return { data: result };
  },
});
