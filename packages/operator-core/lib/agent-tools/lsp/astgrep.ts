/**
 * `code:structural` — the registered surface of the pinned ast-grep leg
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-014).
 *
 * Named for the QUESTION it answers, not the binary that answers it. The
 * routing distinction P-014 asks for lives in the description and guidance,
 * because that is the only place a choosing agent actually reads: `lsp:query`
 * is type truth, `gitnexus.query` is topology, this is shape.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { semgrepTaint } from '../../code-intelligence/semgrep-taint-facade';
import { agentAntipatterns } from '../../code-intelligence/agent-antipatterns';
import {
  AST_GREP_LANGUAGES,
  astGrepFacade,
  astGrepSyntaxIndex,
  type AstGrepLanguage,
} from '../../code-intelligence/ast-grep-facade.ts';

const LANGS = Object.keys(AST_GREP_LANGUAGES) as [AstGrepLanguage, ...AstGrepLanguage[]];

export default defineTool({
  name: 'code:structural',
  description:
    'Find code by SHAPE with pinned ast-grep: `pattern` uses metavariables (`foo($X)`, `if ($C) { $$$BODY }`) and matches syntax, ignoring formatting and strings/comments. op:"search" lists matches; op:"rewrite_preview" shows proposed replacements; op:"syntax_index" indexes declarations/imports/inheritance with source hashes. op:"taint" separately evaluates local data flow with admitted Semgrep OSS against explicit files and caller-declared taint.sources/sinks/sanitizers. Taint returns {analysisKind:"local-taint",findings,sources,analyzer,ruleSha256,freshness,truncation,dynamicBoundary,limitations,error}; it is inferred static evidence, never a runtime or vulnerability verdict. Other ops return {sites,truncation,freshness,evidence?,error}. Locations are ONE-indexed. All operations are read-only.',
  guidance: {
    when: 'The question is about FORM: where an idiom or anti-pattern occurs, the blast radius of a codemod, a lint-shaped sweep. Also when the code does not typecheck — this parses, it does not compile.',
    notWhen:
      'Name resolution (shadowing, re-exports, generics) is lsp:query; call chains and impact are gitnexus.query. For plain text/regex, use scoped rg/grep; see /internal/docs/agent-insights/code-intelligence-backends-runbook.',
    chaining:
      'code:structural to find candidate sites by shape → lsp:query op:"symbol" on one to confirm it resolves where you think. A structural match set is a SUPERSET of the type-correct one.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z
      .enum(['search', 'rewrite_preview', 'syntax_index', 'taint', 'agent_antipatterns'])
      .describe('search lists matches; rewrite_preview reports replacements; syntax_index emits inferred declarations; taint evaluates declared local data flow using Semgrep OSS; agent_antipatterns compares before/source with the maintained advisory rule pack. All are read-only.'),
    before: z.string().max(100_000).optional().describe('agent_antipatterns: exact before source; omitted means unknown, so new skips/timeout increases cannot be inferred.'),
    source: z.string().max(100_000).optional().describe('agent_antipatterns: exact after source. Returns advisory syntax candidates and source hashes.'),
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe('Structural pattern: code with metavariables. `$X` is one node, `$$$X` is many.'),
    language: z
      .enum(LANGS)
      .describe('Grammar to parse the pattern and files with. A pattern is only meaningful under a language.'),
    rewrite: z
      .string()
      .min(1)
      .optional()
      .describe('rewrite_preview only: replacement template, reusing the pattern\'s metavariables. NOTHING is written.'),
    taint: z.object({
      sources: z.array(z.string().min(1).max(2000)).min(1).max(8),
      sinks: z.array(z.string().min(1).max(2000)).min(1).max(8),
      sanitizers: z.array(z.string().min(1).max(2000)).max(8).optional(),
    }).optional().describe('taint only: explicit source, sink and optional sanitizer patterns. No implicit security model or inter-file completeness claim.'),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe('Search/rewrite files or directories; defaults to workspace root. syntax_index requires 1..16 explicit source files, each at most 1 MiB; generated/vendor source is excluded.'),
    rootPath: z.string().min(1).optional().describe('Project root override. Defaults to the agent workspace root.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Cap on returned sites. A cut is always reported via truncation.truncated + totalAvailable.'),
  }),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    if (args.op === 'agent_antipatterns') {
      if (args.source === undefined || !['ts', 'tsx'].includes(args.language)) throw new Error('agent_antipatterns requires source and ts/tsx language');
      return { data: await agentAntipatterns(args.before ?? null, args.source, args.language as 'ts' | 'tsx') };
    }
    if (args.op === 'taint') return { data: await semgrepTaint({ language: args.language, paths: args.paths,
      rootPath: root, patterns: args.taint, limit: args.limit }) };
    if (args.op === 'syntax_index') return { data: await astGrepSyntaxIndex({ language: args.language, paths: args.paths, rootPath: root, limit: args.limit }) };
    if (!args.pattern) throw new Error(args.op + ' requires pattern');
    const answer = await astGrepFacade(args.op, {
      pattern: args.pattern,
      language: args.language,
      rewrite: args.rewrite,
      paths: args.paths,
      rootPath: root,
      limit: args.limit,
    });
    return { data: answer };
  },
});
