/** Shared activation-audit gate used by every plan lifecycle entry door. */

type Tx = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

import { RUBRIC_TEMPLATE_NAME } from './rubric-template';
import { parsePlan } from './parser';
import { evaluateActivationDeclarations, type ActivationDeclarationBlocker } from './plan-declarations';

export const ACTIVATION_PLAN_STATUSES = ['ready', 'active'] as const;

export function isActivationPlanStatus(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'active';
}

/** True only for the transition that ENTERS ready/active, not a later edit. */
export function entersActivationPlanStatus(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return !isActivationPlanStatus(before) && isActivationPlanStatus(after);
}

/**
 * Whether a plan template is exempt from the conversation-audit activation gate.
 *
 * Rubric-template plans are authored through the rubric write path, whose structured
 * document is the source of truth and whose activation is part of proposing/ratifying
 * the rubric itself. Requiring a separate conversation audit would reject every
 * rubric activation and leave the caller with a misleading post-write lookup error.
 * Keep this predicate here so every plan write door shares the same exemption.
 *
 * Child-seed plans are machine-synthesized by spawn_child (synthesizeChildSeedPlan)
 * from the parent's spawn request; they have no source conversation for an audit to
 * read (verification-system-improvements-2026-10-10#D-038). The exemption is NOT
 * self-serve: withPlanLock refuses any write that INTRODUCES this template unless the
 * caller passes `allowChildSeedTemplate`, which only spawn_child's seed writer sets.
 */
export const CHILD_SEED_TEMPLATE_NAME = 'child-seed';

export function isActivationAuditExemptTemplate(template: string | null | undefined): boolean {
  return template === RUBRIC_TEMPLATE_NAME || template === CHILD_SEED_TEMPLATE_NAME;
}

/** True when a write moves a plan's template ONTO child-seed (not a later edit that keeps it). */
export function introducesChildSeedTemplate(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return after === CHILD_SEED_TEMPLATE_NAME && before !== CHILD_SEED_TEMPLATE_NAME;
}

export interface ChildSeedTemplateRefusalValue {
  ok: false;
  code: 'child_seed_template_reserved';
  message: string;
}

/** The non-throwing refusal withPlanLock returns for a self-served child-seed template. */
export function childSeedTemplateRefusalValue(planSlug: string): ChildSeedTemplateRefusalValue {
  return {
    ok: false,
    code: 'child_seed_template_reserved',
    message:
      `Plan '${planSlug}' cannot declare template '${CHILD_SEED_TEMPLATE_NAME}': that template is reserved for ` +
      `seed plans spawn_child synthesizes, because it exempts the plan from the conversation activation audit. ` +
      `Remove the template line, or create the child through plans:promote spawn_child.`,
  };
}

/** The stored reverse-coverage verdict, read defensively from the activation JSON. */
function itemProvenanceCheckOf(
  activation: unknown,
): { enforced: boolean; items: Record<string, string> } | null {
  const parsed = typeof activation === 'string' ? safeJson(activation) : activation;
  const check = (parsed as { itemProvenanceCheck?: unknown } | null)?.itemProvenanceCheck as
    | { enforced?: unknown; items?: unknown }
    | undefined;
  if (!check || typeof check !== 'object' || check.enforced !== true) return null;
  const items = check.items && typeof check.items === 'object' ? (check.items as Record<string, string>) : {};
  return { enforced: true, items };
}

/** True when the stored audit was itself gated on the declaration sections (D-013 #1). */
function declarationsCheckEnforced(activation: unknown): boolean {
  const parsed = typeof activation === 'string' ? safeJson(activation) : activation;
  const check = (parsed as { declarationsCheck?: { enforced?: unknown } } | null)?.declarationsCheck;
  return Boolean(check && typeof check === 'object' && check.enforced === true);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface ConversationActivationGateVerdict {
  satisfied: boolean;
  code?: 'conversation_audit_required' | 'item_provenance_unresolved' | 'plan_declarations_invalid';
  message?: string;
  auditSeq?: number;
  /** P-003: current items the enforced audit did not resolve. */
  unresolvedItems?: string[];
  /** D-013 #1: declaration sections that are missing or invalid in the CURRENT content. */
  declarationBlockers?: ActivationDeclarationBlocker[];
  /** Existing ready/active plan with no audit: activated before this gate could enforce. */
  grandfathered?: boolean;
}

export function conversationAuditRequiredMessage(planSlug: string): string {
  return (
    `Plan '${planSlug}' cannot enter ready/active or start until it has a completed conversation audit. ` +
    `Read the full source conversation with sessions:search/read, then call plans:audit { phase:'activation', ` +
    `slug:'${planSlug}', sourceRanges:[...], mappings:[...] }; repair every omission/open mapping and retry.`
  );
}

export async function evaluateConversationActivationGate(
  tx: Tx,
  scope: {
    workspaceId: string;
    harnessSlug: string;
    planSlug: string;
    /** The plan body being written, when the door evaluates a content write that has not
     *  committed yet. The declaration re-check reads it instead of the stored row. */
    pendingContent?: string | null;
  },
): Promise<ConversationActivationGateVerdict> {
  const rows = await tx<Array<{ audit_seq: number; activation: unknown }>>`
    SELECT audit_seq, activation
      FROM harness_shared.plan_audits
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
       AND audit_kind = 'activation'
     ORDER BY audit_seq DESC
     LIMIT 1`;
  const row = rows[0];
  if (row) {
    // plan-item-provenance-2026-09-29 P-003: an ENFORCED audit resolved a specific
    // item set. An item added (or un-dropped) after it has no recorded provenance, so
    // the lifecycle doors refuse it until a re-audit resolves it. Unenforced (legacy)
    // audits keep passing — they were recorded with the gap as a warning.
    const check = itemProvenanceCheckOf(row.activation);
    if (check?.enforced) {
      const planRows = await tx<Array<{ content: string }>>`
        SELECT content
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${scope.planSlug}
         LIMIT 1`;
      const unresolved = planRows[0]?.content
        ? parsePlan(planRows[0].content, { filePath: `${scope.planSlug}.md` }).items
            .filter((item) => item.storedStatus !== 'dropped')
            .map((item) => item.id)
            .filter((id) => !check.items[id] || check.items[id] === 'unresolved')
        : [];
      if (unresolved.length > 0) {
        return {
          satisfied: false,
          code: 'item_provenance_unresolved',
          auditSeq: Number(row.audit_seq),
          unresolvedItems: unresolved,
          message:
            `Plan '${scope.planSlug}' has item(s) with no recorded provenance since activation audit #${row.audit_seq}: ` +
            `${unresolved.join(', ')}. Re-run plans:audit { phase:'activation' } citing the owner turn for each, or ` +
            'declare it in itemProvenance (derived / agent-added with a reason).',
        };
      }
    }
    // plan-reuse-and-library-declarations-2026-10-20 D-013 #1: the door is the boundary,
    // not the audit row. Every draft or ready plan needs both declaration sections on its
    // CURRENT content, whatever its latest audit recorded: a section removed (or broken)
    // after a gated audit refuses here, and so does a plan whose audit predates the gate
    // (D-004 #1 retrofits by plan status; only active/shipped plans are exempt).
    // EI-26528805324626265: this check used to run only for gated audit rows.
    const declarationRefusal = await declarationsRefusal(tx, scope, {
      auditSeq: Number(row.audit_seq),
      gatedAudit: declarationsCheckEnforced(row.activation),
    });
    if (declarationRefusal) return declarationRefusal;
    return { satisfied: true, auditSeq: Number(row.audit_seq) };
  }

  // EI-21514925652793324: recorder + enforcer can deploy together after plans
  // were already activated on an older operator. A plan already sitting in
  // ready/active when this check runs cannot retroactively create the audit that
  // preceded its transition. Grandfather that EXISTING state only. A fresh
  // draft→ready/active write is evaluated while the stored row is still draft,
  // so it continues to refuse until plans:audit records the activation audit.
  const planRows = await tx<Array<{ content: string }>>`
    SELECT content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
     LIMIT 1`;
  const storedStatus = planRows[0]?.content
    ? parsePlan(planRows[0].content, { filePath: `${scope.planSlug}.md` }).frontmatter.status
    : null;
  if (isActivationPlanStatus(storedStatus)) {
    // The missing AUDIT is grandfathered; the declaration sections are a separate
    // requirement that a READY plan still owes before it starts (D-004 #1).
    const declarationRefusal = await declarationsRefusal(tx, scope, {
      auditSeq: null,
      gatedAudit: false,
      storedContent: planRows[0]?.content ?? '',
    });
    if (declarationRefusal) return declarationRefusal;
    const message =
      `Plan '${scope.planSlug}' is already ${storedStatus} with no activation audit, so it is grandfathered ` +
      'instead of being retroactively blocked. Record plans:audit { phase:\'activation\' } on its next material plan edit.';
    console.warn(`[plan-activation-gate] ${message}`);
    return { satisfied: true, grandfathered: true, message };
  }
  return {
        satisfied: false,
        code: 'conversation_audit_required',
        message: conversationAuditRequiredMessage(scope.planSlug),
      };
}

/**
 * The declaration-section verdict for a lifecycle door (D-013 #1, D-004 #1). The STORED
 * status decides whether the gate applies, so a single write that both enters active
 * and removes a section is still judged as leaving draft/ready; the body judged is the
 * pending write when there is one, else the stored content. Returns null when the
 * sections are valid or the plan's status is exempt.
 */
async function declarationsRefusal(
  tx: Tx,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string; pendingContent?: string | null },
  audit: { auditSeq: number | null; gatedAudit: boolean; storedContent?: string },
): Promise<ConversationActivationGateVerdict | null> {
  const stored =
    audit.storedContent ??
    (
      await tx<Array<{ content: string }>>`
        SELECT content
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${scope.planSlug}
         LIMIT 1`
    )[0]?.content ??
    '';
  const status = stored ? parsePlan(stored, { filePath: `${scope.planSlug}.md` }).frontmatter.status : null;
  const declarations = evaluateActivationDeclarations(scope.pendingContent ?? stored, status);
  if (declarations.ok) return null;
  const blockerText = declarations.blockers
    .map((blocker) => `"## ${blocker.section}" is ${blocker.status} (${blocker.detail})`)
    .join('; ');
  const lead = audit.gatedAudit
    ? `Plan '${scope.planSlug}' passed activation audit #${audit.auditSeq} with its declaration sections, but the ` +
      'current content no longer does'
    : `Plan '${scope.planSlug}' is ${status ?? 'missing a status'} and must carry both declaration sections before ` +
      `it starts (${audit.auditSeq === null ? 'it has no activation audit' : `activation audit #${audit.auditSeq} predates the declaration gate`})`;
  return {
    satisfied: false,
    code: 'plan_declarations_invalid',
    ...(audit.auditSeq === null ? {} : { auditSeq: audit.auditSeq }),
    declarationBlockers: declarations.blockers,
    message:
      `${lead}: ${blockerText}. ` +
      (audit.gatedAudit
        ? "Restore each section's JSON block, or set its notApplicable to a one-line reason."
        : 'Add each section with its fenced JSON block (plans:new scaffolds both), or set its notApplicable to a ' +
          'one-line reason, then retry.'),
  };
}

export type ActivationGateRefusalCode = NonNullable<ConversationActivationGateVerdict['code']>;

/** The non-throwing refusal withPlanLock returns when a lifecycle door fails the
 *  activation gate. It carries the gate's OWN verdict — a missing conversation audit
 *  and an item with no recorded provenance (plan-item-provenance-2026-09-29 P-003)
 *  need different repairs, so the door must not collapse one into the other. */
export interface ActivationGateRefusalValue {
  ok: false;
  code: ActivationGateRefusalCode;
  message: string;
  unresolvedItems?: string[];
  declarationBlockers?: ActivationDeclarationBlocker[];
}

export function activationGateRefusalValue(
  planSlug: string,
  verdict: ConversationActivationGateVerdict,
): ActivationGateRefusalValue {
  return {
    ok: false,
    code: verdict.code ?? 'conversation_audit_required',
    message: verdict.message ?? conversationAuditRequiredMessage(planSlug),
    ...(verdict.unresolvedItems?.length ? { unresolvedItems: verdict.unresolvedItems } : {}),
    ...(verdict.declarationBlockers?.length ? { declarationBlockers: verdict.declarationBlockers } : {}),
  };
}

const ACTIVATION_GATE_REFUSAL_CODES: ReadonlySet<string> = new Set<ActivationGateRefusalCode>([
  'conversation_audit_required',
  'item_provenance_unresolved',
  'plan_declarations_invalid',
]);

/** Typed guard for the non-throwing refusal returned by withPlanLock. */
export function isActivationGateRefusalValue(value: unknown): value is ActivationGateRefusalValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActivationGateRefusalValue>;
  return (
    candidate.ok === false &&
    typeof candidate.code === 'string' &&
    ACTIVATION_GATE_REFUSAL_CODES.has(candidate.code) &&
    typeof candidate.message === 'string'
  );
}

export function domainFailureMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
