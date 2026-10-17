/**
 * Mint the blind gap reviewer (verification-system-improvements-2026-10-10 D-006 (2),
 * D-041; WI-6554700010008492).
 *
 * The P-006 door (blind-review-gate.ts, plans:blind-review) records a reviewer's gaps and
 * refuses a reviewer in the author's lineage. This module supplies the reviewer itself: a
 * FRESH headless session, launched under a system actor (so the door's lineage check
 * accepts its post), whose MCP tool surface is confined BEFORE its process starts.
 *
 * The confinement is an exact CEILING (denyOutside), not a slug-keyed deny list. Plan text
 * reaches a session through many families besides plans:* — rubrics, scorecards, search,
 * sessions, memory, work items derived from plan items, coord plan events — so a deny list
 * is only as good as its author's memory. A ceiling names what the reviewer needs and
 * refuses everything else, including tools registered after this was written.
 * denyAmbientContext suppresses hook/recall injections, which also carry plan text.
 *
 * Out of scope (D-041 (4)): reads that are not MCP calls (native Read, or capability:bash
 * `cat` of a plan file). The ceiling closes the MCP half only.
 */
import { validProductReadBoundary, type ProductReadBoundary, type SessionToolConfinement } from './capability-envelope/session-confinement';
import { BLIND_REVIEW_TOOL, loadBlindReviewBrief } from './blind-review-gate';
import type { BlindReviewBrief } from './blind-review-brief';

export const BLIND_GAP_REVIEW_ACTOR = 'system:blind-gap-review';

/**
 * Account the reviewer launches on: the gateway pool, like the acceptance grader and the
 * grading audit (GRADING_AUDIT_ACCOUNT). Omitting it falls back to launch-agent's
 * 'default' — the box's own system login — so one revoked or rate-limited login killed
 * every reviewer on its first turn while gateway launches kept working (WI-6554700010008650).
 */
export const BLIND_GAP_REVIEW_ACCOUNT = 'auto' as const;

/**
 * Everything a blind reviewer may call. Each entry carries why it is here; nothing in this
 * list returns plan artifacts.
 */
export const BLIND_REVIEWER_TOOL_CEILING: readonly string[] = Object.freeze([
  // Identity: the reviewer can confirm who it is.
  'coord:whoami',
  // Deferred-tool access on a trimmed surface. tools:invoke re-checks the INNER name at
  // the dispatch seat, so it cannot reach a tool outside this ceiling.
  'tools:find',
  'tools:invoke',
  // The door: op 'brief' (owner turns only) and op 'post' (the gaps).
  BLIND_REVIEW_TOOL,
  // Running the product. A psu session's native Bash has no network, so the reviewer
  // drives the running build through these.
  'capability:bash',
  'capability:bash_output',
  'dev:service_health',
]);

export type BlindReviewerProductReads = {
  docsHarness?: string;
  docsSlugs?: string[];
  testFiles?: string[];
};

export function blindReviewerConfinement(slug: string, productReads?: ProductReadBoundary): SessionToolConfinement {
  return Object.freeze({
    denyTools: Object.freeze([] as string[]),
    denyOutside: productReads ? Object.freeze([...BLIND_REVIEWER_TOOL_CEILING,
      ...(productReads.docsSlugs.length ? ['docs:get'] : []),
      ...(productReads.testFiles.length ? ['testing:runs', 'testing:run'] : []),
    ]) : BLIND_REVIEWER_TOOL_CEILING,
    ...(productReads ? { denyProductReadsOutside: Object.freeze({ ...productReads,
      docsSlugs: Object.freeze([...productReads.docsSlugs]), testFiles: Object.freeze([...productReads.testFiles]),
    }) } : {}),
    denyAmbientContext: true as const,
    imposedBy: BLIND_GAP_REVIEW_ACTOR,
    reason:
      `you are the blind gap reviewer for ${slug}: judge the product against the owner's ` +
      `words only, without reading the plan, its rubric or its evidence (D-006)`,
  });
}

export function buildBlindReviewerKickoff(brief: BlindReviewBrief, howToRun?: string | null, productReads?: ProductReadBoundary): string {
  const run = howToRun?.trim()
    ? howToRun.trim()
    : 'Find the running build yourself (dev:service_health), then exercise it with capability:bash.';
  return [
    `# Blind gap review: ${brief.planSlug}`,
    '',
    'You review a finished feature WITHOUT seeing its plan. Below are the owner\'s own words.',
    'Run the product, then list every place where what the owner asked for is missing,',
    'wrong, or only partly there. Plan, rubric and evidence tools are refused for this',
    'session on purpose; a refusal is expected, not an obstacle to route around.',
    '',
    '## How to run the product',
    run,
    ...(productReads ? [
      '',
      'Nominated product reads (all other documentation and ledger selectors remain refused):',
      ...productReads.docsSlugs.map(slug => `docs:get { harness: '${productReads.docsHarness}', slugs: ['${slug}'] }`),
      ...productReads.testFiles.map(file => `testing:runs { harness: '${productReads.harness}', filePath: '${file}', source: 'mutation-probe', sinceHours: 24, limit: 20 }`),
      ...productReads.testFiles.map(file => `testing:run { harness: '${productReads.harness}', files: ['${file}'], timeoutMs: 120000, maxFailures: 5 }`),
      'Run nominated tests through testing:run: its server-side source-hold preflight admits the exact files before execution. The offline capability:bash sandbox cannot query that ledger.',
      'These are maintained product docs and raw test-file history, not the plan, its bound proof, or an author-selected proof ID.',
    ] : []),
    '',
    '## The owner\'s words',
    brief.text,
    '',
    '## Report',
    `Call ${BLIND_REVIEW_TOOL} { op: 'post', slug: '${brief.planSlug}', gaps: [...] }`,
    '(gaps: [] when you found none), then end your session.',
  ].join('\n');
}

type LaunchHandler = (args: Record<string, unknown>, ctx: never) => Promise<unknown>;

export interface MintBlindGapReviewerDeps {
  loadBrief?: typeof loadBlindReviewBrief;
  /** The launch-agent handler plus its confinement symbol; injected in tests. */
  launcher?: () => Promise<{ handler: LaunchHandler; confinementKey: symbol }>;
}

export type MintBlindGapReviewerResult =
  | { ok: true; launch: unknown; kickoff: string; activationAuditSeq: number }
  | { ok: false; code: 'workspace_required' | 'no_activation_audit' | 'no_owner_turns' | 'invalid_product_reads'; message: string };

async function defaultLauncher(): Promise<{ handler: LaunchHandler; confinementKey: symbol }> {
  const mod = await import('./agent-tools/capability/launch-agent');
  return {
    handler: (args, ctx) => mod.default.handler(args as never, ctx),
    confinementKey: mod.INTERNAL_SCOPED_SESSION_CONFINEMENT,
  };
}

export async function mintBlindGapReviewer(
  input: { slug: string; harness: string; howToRun?: string | null; productReads?: BlindReviewerProductReads; ctx: Record<string, unknown> },
  deps: MintBlindGapReviewerDeps = {},
): Promise<MintBlindGapReviewerResult> {
  const workspaceId = typeof input.ctx.workspaceId === 'string' ? input.ctx.workspaceId.trim() : '';
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, code: 'workspace_required', message: 'A blind reviewer mint needs a concrete workspace.' };
  }
  const brief = await (deps.loadBrief ?? loadBlindReviewBrief)({
    workspaceId, planSlug: input.slug, harnessSlug: input.harness,
  });
  if (!brief) {
    return { ok: false, code: 'no_activation_audit',
      message: `${input.slug} has no activation audit, so there are no owner turns to brief a reviewer with.` };
  }
  if (brief.ownerTurns.length === 0) {
    return { ok: false, code: 'no_owner_turns',
      message: `${input.slug}'s activation audit resolves no authenticated owner turns. Repair source-origin enrollment and audit mappings before minting a blind reviewer.` };
  }
  const productReads = input.productReads ? { harness: input.harness,
    docsHarness: input.productReads.docsHarness ?? input.harness,
    docsSlugs: input.productReads.docsSlugs ?? [], testFiles: input.productReads.testFiles ?? [],
  } : undefined;
  if (productReads && !validProductReadBoundary(productReads)) {
    return { ok: false, code: 'invalid_product_reads', message: 'Product reads require exact documentation slugs, test file paths and concrete harnesses.' };
  }
  const kickoff = buildBlindReviewerKickoff(brief, input.howToRun, productReads);
  const { handler, confinementKey } = await (deps.launcher ?? defaultLauncher)();
  // A SYSTEM effect, not the caller's personal launch: the reviewer must descend from this
  // actor, or the door's lineage check rejects it as the author's child. Same pattern as
  // launchAcceptanceGraderForGate (agent-tools/plans/set-plan-status.ts).
  const systemCtx = {
    ...input.ctx,
    harnessSlug: input.harness,
    uiClientId: null,
    isSuperuser: false,
    isPowerUser: false,
    principal: { kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId },
    ownerId: BLIND_GAP_REVIEW_ACTOR,
    ownerLabel: 'blind gap review',
    userId: null,
    [confinementKey]: blindReviewerConfinement(input.slug, productReads),
  };
  const launch = await handler(
    {
      brief: kickoff,
      harness: input.harness,
      headless: true,
      // Use the native backend used by grading-audit recovery. An implicit
      // Claude launch can strand a confined review on a completed provider
      // API error while its PTY remains live (EI-25752839878478687).
      agent: 'codex',
      account: BLIND_GAP_REVIEW_ACCOUNT,
      // A confined reviewer must reach the door and product on the build that
      // minted it. The stable endpoint may still serve an older tool catalog.
      mcpTarget: 'spawn-host',
    },
    systemCtx as never,
  );
  return { ok: true, launch, kickoff, activationAuditSeq: brief.activationAuditSeq };
}
