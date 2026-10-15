/**
 * platform:contribute — send a local improvement UPSTREAM from a platform-mode
 * install (per-hive-learning-loops-2026-06-14 P-072; D-006/D-007/D-008).
 *
 * The OUTWARD-FACING leg of platform mode. Where platform:enable (P-071) stands
 * Papercusp's own repo up as a private self-managed shared Hive that dogfoods
 * locally, this orchestrates the two contribution round-trips D-007 ratified —
 * REUSING the proven surfaces, never rebuilding them:
 *
 *   kind:'knowledge-pack' — export the self-hive's organic learnings into a pack
 *     (knowledge_packs:export's core) then LIST it on the Comb
 *     (knowledge_packs:publish's core). The listing lands PENDING (operator
 *     approval gates public visibility, D-007 moderation gate).
 *
 *   kind:'pr' — commit + push the local change to the USER'S OWN FORK (never
 *     canonical Papercusp) and open a human-reviewed PR fork→canonical via the
 *     octokit PR host (open-fork-pr's core). A user's loop NEVER direct-pushes to
 *     canonical Papercusp (D-007).
 *
 * ROOT-ONLY (mirrors platform:enable / pot:dissolve) + reason-audited. The
 * composition lives in `../../hive/contribute-upstream` (seam-injected,
 * unit-tested); this is the guard + arg surface.
 *
 * "PREPARED, NOT SENT" by default — the LIVE outward action (git push, gh PR
 * create, Comb publish) fires ONLY when invoked with `confirm:true` AND the
 * credentials/remote are present. Without confirm or without creds the tool
 * returns `{ ok, prepared:true, needs:[...] }` — it NEVER throws and NEVER
 * auto-fires an outward action.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { contributeUpstream } from '../../pot/contribute-upstream';
import { PLATFORM_SELF_POT_SLUG } from '../../pot/enable-platform-mode';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'platform:contribute',
  profile: 'engineer',
  description:
    "Contribute upstream through existing platform surfaces: knowledge-pack publishes a moderated Comb listing, pr opens a fork→canonical PR, report files anonymously through the canonical joined-Pot shared intake and existing issue federation. Reports return queued, never an unverified upstream receipt. Root-only; confirm:true is required to submit. Without consent or prerequisites, returns prepared:true with needs.",
  guidance: {
    when: 'The user explicitly wants to contribute a knowledge-pack or fork PR (requires platform:enable), or submit an installed-app problem report (requires canonical-Pot membership and confirm:true consent). A report returns queued for existing federation, not an upstream delivery receipt.',
    notWhen:
      'Enabling platform mode / standing up the self-hive — platform:enable. Publishing a pack for an ARBITRARY (non-platform) hive — knowledge_packs:export + knowledge_packs:publish. Opening a PR for a normal harness feature — the orchestrator fork-PR hook.',
    chaining:
      'platform:enable (stand up the self-hive) → set the self-hive member\'s fork_remote (for kind:\'pr\') → platform:contribute (prepared) → review the plan/needs → platform:contribute { confirm:true } to send.',
    seeAlso: [
      'platform:enable (stand up the self-hive first)',
      'platform:dogfood_verify (confirm the PR loop closed)',
      'knowledge_packs:publish (publish a pack for a non-platform hive)',
    ],
  },
  capability: 'harness:write',
  // The contribution resolves the self-hive member from the workspace registry +
  // performs the outward git/Comb actions; run cross-workspace like platform:enable
  // so the resolution isn't wrapped in an RLS tx it doesn't need.
  crossWorkspace: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    kind: z
      .enum(['knowledge-pack', 'pr', 'report'])
      .describe(
        "Contribution kind: knowledge-pack (moderated Comb listing), pr (fork→canonical PR), or report (shared intake + existing canonical-Pot federation, with explicit consent).",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Required true to FIRE the live outward action (git push + PR create, or Comb publish). Without it the tool returns a prepared "not sent" result describing what it would do + what it needs.',
      ),
    reason: z
      .string()
      .min(8, 'Provide a short reason (>=8 chars) for the audit log.')
      .describe('Why this improvement is being contributed upstream — recorded for audit (this is an outward-facing action).'),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .optional()
      .describe(`Base slug of the self-hive (default ${PLATFORM_SELF_POT_SLUG}; member = <base>, home = <base>-hive).`),

    // ── knowledge-pack path ──
    packId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("kind:'knowledge-pack' — kebab-case pack id (becomes the Comb listing_ref)."),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe("kind:'knowledge-pack' — pack title."),
    description: hardText(LIMITS.ANNOTATION)
      .optional()
      .describe("kind:'knowledge-pack' — short pack description."),
    version: z.string().optional().describe("kind:'knowledge-pack' — three-part semver (default 1.0.0)."),
    includePackRows: z
      .boolean()
      .optional()
      .describe("kind:'knowledge-pack' — re-export installed-pack content too (default false: organic learnings only)."),

    // ── pr path ──
    featureBranch: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("kind:'pr' — the local feature branch in the self-hive checkout that holds the change's commits."),
    prTitle: hardText(LIMITS.SHORT_TITLE).optional().describe("kind:'pr' — the PR title."),
    prBody: hardText(8000).optional().describe("kind:'pr' — the PR body."),

    workspace: z.string().max(120).optional().describe('Workspace id (default: active workspace).'),
    report: z.object({
      text: z.string().min(1).max(8000),
      title: z.string().max(120).optional(),
      reportContext: z.object({
        app: z.string().max(200).optional(),
        appVersion: z.string().max(200).optional(),
        screen: z.object({
          route: z.string().max(2000).optional(),
          url: z.string().max(2000).optional(),
          state: z.record(z.string(), z.string().max(2000)).optional(),
        }).strict().optional(),
        recentErrors: z.array(z.object({ message: z.string().min(1).max(2000), source: z.string().max(200).optional() }).strict()).max(10).optional(),
        logExcerpt: z.string().max(6000).optional(),
      }).strict().optional(),
    }).strict().optional().describe("kind:'report': anonymous report for the canonical joined Pot. confirm:true records consent; optional logExcerpt must be explicitly opted in. Returns queued, not received upstream."),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (mirrors platform:enable / pot:dissolve): an outward
    // contribution is an owner/operator action, never delegated to a bee.
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'platform_contribute_root_only',
        message:
          'platform:contribute cannot be called from a bee (a spawned/parented agent). Contributing upstream is an owner/operator action.',
      });
    }

    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);

    const res = await contributeUpstream({
      kind: args.kind,
      ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
      workspaceId,
      ...(args.slug ? { slug: args.slug } : {}),
      ...(args.packId ? { packId: args.packId } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.version ? { version: args.version } : {}),
      ...(args.includePackRows !== undefined ? { includePackRows: args.includePackRows } : {}),
      ...(args.featureBranch ? { featureBranch: args.featureBranch } : {}),
      ...(args.prTitle ? { prTitle: args.prTitle } : {}),
      ...(args.prBody ? { prBody: args.prBody } : {}),
      ...(args.report ? { report: args.report } : {}),
    });

    // Best-effort audit (mirrors platform:enable): record the contribution intent
    // with its reason. Only a SENT contribution is an outward effect worth the
    // audit weight; a prepared/declined run is a dry-run.
    if (res.ok && 'sent' in res && res.sent) {
      try {
        const { recordFlagAudit } = await import('../../flag-audit');
        const { FLAGS } = await import('@papercusp/flags');
        await recordFlagAudit(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, true, ctx?.principal?.slug ?? 'agent', {
          reason: `platform:contribute (${args.kind}) — ${args.reason}`,
          backend: 'platform-contribute',
        });
      } catch {
        /* audit is best-effort; never fail the contribution on it */
      }
    }

    return text(res as unknown as Record<string, unknown>);
  },
});
