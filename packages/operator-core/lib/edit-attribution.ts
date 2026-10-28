/**
 * edit-attribution — the P-001 edit-time CAPTURE of
 * deterministic-commit-workitem-attribution-2026-06-22.
 *
 * Writes one harness_shared.edit_attribution_ledger row per granted file edit, joining
 * the lock holder's claimed lane (work-item + harness) AT EDIT TIME (D-002) so attribution
 * SURVIVES the agent's session ending before the ~10-min git-sync tick. git-sync reads this
 * window back by repo_root+file to attribute its per-agent commits (P-003), and the durable
 * git_sync_commit_attribution link (P-004) feeds the doc-drift (P-005) + merge-resolver
 * (P-006) consumers.
 *
 * DETERMINISTIC + best-effort (D-001/D-006): pure server code — NO LLM, NO extra agent tool
 * call (the work-item is read from the claim the agent ALREADY holds). Called fire-and-forget
 * from the locks:acquire grant; ANY failure here is swallowed and must NEVER affect the lock
 * (the hot per-edit path). Mirrors the best-effort raw-SQL pattern of lib/decision-ledger/emit.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getPresence } from './agent-tools/coordination/presence';
import { isLifecycleIntent } from './agent-tools/coordination/presence-payload';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

export interface RecordEditAttributionInput {
  /** The lock's coordination domain — the physical repo root (the join key). */
  repoRoot: string;
  /** Superproject-relative paths the lock was granted over. */
  files: string[];
  /** The lock holder's stable owner id. */
  agentId: string;
  /** The lock's per-edit intent. */
  intent?: string;
  /** The editing agent's workspace — required to look up its claimed lane. */
  workspaceId?: string;
  /**
   * The caller's queue-time/current goal pointer. When present it is validated
   * against canonical work-item ownership and never replaced with a guessed
   * claim. Absent preserves the legacy claim-store fallback.
   */
  goalRef?: string;
  sessionId?: string;
  contributor?: string;
  /** Dispatcher call id for duplicate-safe server-side edit capture. */
  dispatchCallId?: string;
}

/**
 * How an edit row's work_item_id was chosen — persisted as
 * edit_attribution_ledger.work_item_resolution (migration 1599). Plan
 * change-provenance-and-admission-throughput-2026-10-27 P-005 (R-4).
 */
export type EditWorkItemResolution =
  | 'goal-ref' // the caller's goal pointer names an item the editor holds
  | 'goal-ref-unowned' // the pointer names nothing the editor holds: NULL, never a guess
  | 'single-holder' // the editor holds exactly one item
  | 'lock-intent' // several held; the lock's own intent names exactly one
  | 'declared-intent' // several held; the presence intent names exactly one
  | 'ambiguous' // several held, none singled out: NULL + candidates
  | 'none' // the editor holds nothing
  | 'lookup-failed' // the held-set read failed: NULL (unknown, not "none")
  | 'no-workspace'; // no workspace scope to resolve within

export interface HeldWorkItemRef {
  harnessSlug: string | null;
  workItemId: string;
}

export interface EditWorkItemChoice {
  harnessSlug: string | null;
  workItemId: string | null;
  resolution: EditWorkItemResolution;
  /** The held ids when no single one was chosen (ambiguous / goal-ref-unowned); else null. */
  candidates: string[] | null;
}

/** Held items whose id appears in `text` as a whole token (WI-12 never matches WI-123). */
function heldItemsNamedIn(text: string | null, held: readonly HeldWorkItemRef[]): HeldWorkItemRef[] {
  if (!text) return [];
  return held.filter((item) => {
    const id = item.workItemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_])`).test(text);
  });
}

/**
 * Pure: choose the work-item an edit belongs to from what its editor HOLDS. A goal pointer
 * wins when it names a held item and yields an honest NULL when it does not (it never falls
 * through to a different item). Otherwise one held item is stamped; several are narrowed by
 * the lock intent, then the declared presence intent, each only when it names exactly one;
 * anything else stays NULL with the held ids as candidates, so "ambiguous" is readable apart
 * from "held nothing". `held === null` means the read failed — unknown, never "none".
 */
export function resolveEditWorkItem(input: {
  goalRef: string | null;
  held: readonly HeldWorkItemRef[] | null;
  lockIntent: string | null;
  declaredIntent: string | null;
}): EditWorkItemChoice {
  const chose = (item: HeldWorkItemRef, resolution: EditWorkItemResolution): EditWorkItemChoice => ({
    harnessSlug: item.harnessSlug,
    workItemId: item.workItemId,
    resolution,
    candidates: null,
  });
  const unresolved = (resolution: EditWorkItemResolution, candidates: string[] | null = null): EditWorkItemChoice => ({
    harnessSlug: null,
    workItemId: null,
    resolution,
    candidates,
  });
  const { held } = input;
  if (held === null) return unresolved('lookup-failed');
  const ids = held.map((item) => item.workItemId);
  if (input.goalRef) {
    const item = held.find((h) => h.workItemId === input.goalRef);
    return item ? chose(item, 'goal-ref') : unresolved('goal-ref-unowned', ids.length > 0 ? ids : null);
  }
  if (held.length === 0) return unresolved('none');
  if (held.length === 1) return chose(held[0]!, 'single-holder');
  const byLock = heldItemsNamedIn(input.lockIntent, held);
  if (byLock.length === 1) return chose(byLock[0]!, 'lock-intent');
  const byIntent = heldItemsNamedIn(input.declaredIntent, held);
  if (byIntent.length === 1) return chose(byIntent[0]!, 'declared-intent');
  return unresolved('ambiguous', ids);
}

/** Cap on the held set read per edit; a holder past it is pathological, and the cap bounds the candidates array. */
const EDIT_HELD_SET_LIMIT = 100;

/**
 * The editor's non-terminal held work-items (work_items.taken_by), observation lane
 * excluded. Returns null when the read fails so the caller records 'lookup-failed'.
 * carry-brief's readHeldWorkItems also loads summaries and checkpoints — too heavy for the
 * per-edit lock path — so this is the two-column form of the same population.
 */
async function readEditorHeldWorkItems(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  agentId: string,
): Promise<HeldWorkItemRef[] | null> {
  try {
    const rows = await sql<Array<{ harness_slug: string | null; feature_id: string }>>`
      SELECT harness_slug, feature_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND taken_by = ${agentId}
         AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
         AND lane IS DISTINCT FROM 'observation'
       ORDER BY feature_id
       LIMIT ${EDIT_HELD_SET_LIMIT}
    `;
    return rows.map((row) => ({ harnessSlug: row.harness_slug, workItemId: row.feature_id }));
  } catch {
    return null;
  }
}

/**
 * Append edit-attribution ledger rows for a just-granted lock. Resolves the work-item from
 * the editor's held set (resolveEditWorkItem), records how it was chosen, then writes one
 * row per file. Never throws (except in strict mode).
 */
export async function recordEditAttribution(
  input: RecordEditAttributionInput,
  opts: { strict?: boolean; awaitSymbols?: boolean } = {},
): Promise<void> {
  try {
    const files = (input.files ?? []).filter(Boolean);
    if (files.length === 0 || !input.agentId || !input.repoRoot) return;

    const { sql } = getOrgPg();

    // The work-item join, at edit time (D-002), resolved from the HELD set — the editor's
    // non-terminal work_items.taken_by rows — never from the short-lived work_item_claims
    // lease. Plan change-provenance-and-admission-throughput-2026-10-27 P-005 (R-4): the
    // lease held 13 rows fleet-wide while 1,185 of 2,167 unstamped Claude edits in 24 h came
    // from agents that DID hold an item. Started here, awaited after presence (it needs the
    // declared intent), so the two reads overlap on this per-edit hot path.
    const heldRead = input.workspaceId
      ? readEditorHeldWorkItems(sql, input.workspaceId, input.agentId)
      : null;

    // WI-6584: plan_slug was UNCONDITIONALLY written as NULL here — the input type didn't
    // even carry a planSlug field, so there was nothing to thread even if a caller wanted to.
    // `work_item_claims` (the join above) has no plan_slug column at all (a work-item claim
    // and a declared plan lane are different things), so the only live source for "which plan
    // is this agent working under, right now" is its own presence row (coord:declare-intent /
    // coord:orient write `current_plan_slug` there — agent-coordination-architecture-v2 §4.2).
    // One more cheap single-row indexed read (by agentId, overlapping the held-set read above);
    // best-effort like everything else here — absent/stale presence just means an honest
    // unattributed plan_slug, never a guess.
    let planSlug: string | null = null;
    const presence = await getPresence(input.agentId).catch(() => null);
    if (presence?.currentPlanSlug) planSlug = presence.currentPlanSlug;

    // EI-20055604348536487: `intent` must carry what the agent said it was DOING (D-002) — but
    // the automatic per-edit file-lock hook acquires with `intent: f'PreToolUse:{tool_name}'`,
    // and locks:acquire passes that straight through, so 97.5% of this column was the name of
    // the hook rather than any intent (measured 24h/n=3,257: 3,047 'PreToolUse:Edit' + 210
    // 'PreToolUse:Write' vs ~50 real). git-sync renders this field as the COMMIT SUBJECT, so
    // the sentinel was one reader-side filter away from becoming fleet-wide commit messages.
    //
    // The agent's declared coord intent is ALREADY in hand — `presence` is fetched just above
    // for plan_slug (WI-6584) — so recovering the real value costs NO extra query on this
    // per-edit hot path. The lifecycle label moves to `acquired_via` (784) rather than being
    // discarded: it is the only thing the column carried, and "did this edit come through the
    // automatic hook" stays worth knowing.
    //
    // HONEST LIMIT: a declared intent can be STALE (declared at orient, not re-declared since),
    // so this is "what the agent last said it was doing", not proof of this edit's purpose. That
    // is the same freshness the plan_slug above and enrich-busy's `holder_intent` already accept,
    // and it is strictly better than a label that describes no work at all. When neither side has
    // a usable intent we write NULL — an honest unattributed edit (D-003), never a guess.
    const rawIntent = input.intent?.trim() || null;
    const lifecycleLabel = isLifecycleIntent(rawIntent);
    const declaredIntent = presence?.intent?.trim() || null;
    const intent = lifecycleLabel
      ? isLifecycleIntent(declaredIntent)
        ? null
        : declaredIntent
      : rawIntent;
    const acquiredVia = lifecycleLabel ? rawIntent : null;

    const choice: EditWorkItemChoice = heldRead
      ? resolveEditWorkItem({
          goalRef: input.goalRef?.trim() || null,
          held: await heldRead,
          lockIntent: lifecycleLabel ? null : rawIntent,
          declaredIntent: isLifecycleIntent(declaredIntent) ? null : declaredIntent,
        })
      : { harnessSlug: null, workItemId: null, resolution: 'no-workspace', candidates: null };
    const { harnessSlug, workItemId } = choice;

    // One row per file via unnest — a single round-trip on the hot path.
    const inserted = await sql<{ id: string; file: string }[]>`
      INSERT INTO harness_shared.edit_attribution_ledger
        (repo_root, file, agent_id, session_id, contributor, workspace_id,
         harness_slug, work_item_id, plan_slug, intent, acquired_via, dispatch_call_id,
         work_item_resolution, work_item_candidates)
      SELECT ${input.repoRoot}, f, ${input.agentId}, ${input.sessionId ?? null},
             ${input.contributor ?? null}, ${input.workspaceId ?? null},
             ${harnessSlug}, ${workItemId}, ${planSlug}, ${intent}, ${acquiredVia},
             ${input.dispatchCallId ?? null},
             ${choice.resolution}, ${choice.candidates}::text[]
        FROM unnest(${files}::text[]) AS f
      ON CONFLICT DO NOTHING
      RETURNING id::text, file
    `;

    // P-007 (code-intel-delivery-and-outcomes-2026-10-26): stamp the enclosing
    // function/class names of the edit on the rows just written. It runs off the
    // lock path (git show + one compiler parse per file) unless a caller awaits
    // it; a capture that cannot measure leaves `symbols` NULL (unknown).
    if (Array.isArray(inserted) && inserted.length > 0) {
      const capture = import('./code-intelligence/edited-symbols')
        .then(({ fillEditedSymbols }) => fillEditedSymbols(inserted, input.repoRoot, sql))
        .catch(() => 0);
      // P-002 (same plan, D-018): journal edit-time interface eligibility on the same
      // rows, the independent denominator the `interface` push leg's liveness reads.
      // Peers are scoped by the row's harness, else the editor's presence pot.
      const interfaceCapture = import('./code-intelligence/edit-interface-capture')
        .then(({ fillInterfaceEligibility }) => fillInterfaceEligibility(inserted, {
          repoRoot: input.repoRoot, workspaceId: input.workspaceId ?? null, harnessSlug,
          scopeHarness: harnessSlug ?? presence?.potSlug ?? null, agentId: input.agentId,
        }, sql))
        .catch(() => 0);
      if (opts.awaitSymbols) await Promise.all([capture, interfaceCapture]);
    }
  } catch (error) {
    // best-effort: edit attribution must NEVER break the lock path — except for the
    // one caller that needs the row to exist (strict, below).
    if (opts.strict) throw error;
  }
}

/**
 * The same write, but it THROWS when the insert fails instead of swallowing it.
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571): for an owner
 * holding an active personal disclosure, this row is what holds the edited path out
 * of git-sync (personal-vault/git-sync-hold.ts), so locks:release writes it BEFORE
 * releasing and keeps the lock when the write fails. Every other caller stays
 * best-effort.
 */
export async function recordEditAttributionStrict(input: RecordEditAttributionInput): Promise<void> {
  await recordEditAttribution(input, { strict: true });
}

/** One agent's attributed edits in a repo, as git-sync reads them back (P-003). Shaped to
 *  AttributionRosterEntry (git-sync-attribution.ts) — superproject-relative `files`. */
export interface LedgerRosterEntry {
  agent: string;
  files: string[];
  workItems: string[];
  planSlug?: string;
  intent?: string;
  sessionId?: string;
  contributor?: string;
  /** Latest edit timestamp for each repo-relative file in this provenance cohort. */
  editedAtMsByFile?: Record<string, number>;
}

interface LedgerRow {
  agent_id: string;
  file: string;
  work_item_id: string | null;
  plan_slug: string | null;
  intent: string | null;
  session_id: string | null;
  contributor: string | null;
  edited_at_ms?: number | string | null;
}

/**
 * Build git-sync's attribution roster for a repo from the edit ledger (P-003) — the
 * DURABLE source (D-002), so a commit is attributed even after the editing agent's session
 * ended (which live-presence derivation misses). Each file is attributed to its MOST-RECENT
 * editor within `lookbackHours` (DISTINCT ON (file) ORDER BY ts DESC); rows are then grouped
 * by agent. Best-effort: returns [] on any error so the caller falls back to presence.
 *
 * ⚠ SCOPED BY workspace_id, NOT repo_root (WI-37668) — do NOT "restore" a repo_root filter.
 * The ledger's `repo_root` column is written from the LOCK COORDINATION DOMAIN
 * (locks/identity.ts readIdentity → lockCoordinationDomain()), which resolves to the repo root
 * of whichever OPERATOR PROCESS served the locks:acquire call — NOT the repo the edited files
 * live in. This box serves locks from the release checkout while agents edit the staging tree,
 * so rows land under `…/papercup-release` while git-sync syncs `…/papercusp`. The old
 * `WHERE repo_root = <git-sync's root>` therefore matched ZERO rows and made derived
 * attribution silently inert: measured 2026-08-10, 3,379 rows/24h under the serving root vs 0
 * under the sync root (last row under the sync root: 2026-07-17). Fixing this writer-side is
 * not available — locks:acquire receives already-repo-relative paths and carries no
 * harness/project context, so it cannot know the file's true repo root.
 *
 * DISCRIMINATION is workspace scoping PLUS the caller's dirty-file intersection: git-sync
 * partitions the DIRTY set (git-sync-attribution.buildAttributionGroups), so a roster entry for
 * a file that is not dirty in this repo never matches. Residual risk: two repos in ONE workspace
 * sharing a repo-relative path, both dirty, both edited inside the window, could cross-attribute
 * a trailer. Tighten by also scoping on harness_slug once that column is reliably populated — it
 * is NULL on ~99.6% of rows today because it is joined from the agent's active work-item claim.
 */
export async function readEditAttributionRoster(opts: {
  /** The syncing repo's workspace — the join key. Absent ⇒ [] (unscopable, never read globally). */
  workspaceId: string | null | undefined;
  lookbackHours?: number;
}): Promise<LedgerRosterEntry[]> {
  try {
    const { workspaceId, lookbackHours = 24 } = opts;
    if (!workspaceId) return [];
    const { sql } = getOrgPg();
    const rows = await sql<LedgerRow[]>`
      SELECT DISTINCT ON (file)
             agent_id, file, work_item_id, plan_slug, intent, session_id, contributor,
             extract(epoch FROM ts) * 1000 AS edited_at_ms
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ${workspaceId}
         AND ts >= now() - make_interval(hours => ${lookbackHours})
       ORDER BY file, ts DESC
    `;
    // One agent can edit different files under different work-items inside the
    // lookback window. Keep those provenance cohorts separate: collapsing only
    // by agent unions an older lane onto newer files and makes git-sync stamp a
    // commit with the wrong Papercusp-Work-Item trailer (EI-21193794700858679).
    const byProvenance = new Map<string, LedgerRosterEntry>();
    for (const r of rows) {
      const key = JSON.stringify([
        r.agent_id,
        r.work_item_id,
        r.plan_slug,
        r.intent,
        r.session_id,
        r.contributor,
      ]);
      let e = byProvenance.get(key);
      if (!e) {
        e = { agent: r.agent_id, files: [], workItems: [] };
        byProvenance.set(key, e);
      }
      const editedAtMs = Number(r.edited_at_ms);
      if (Number.isFinite(editedAtMs)) {
        e.editedAtMsByFile ??= {};
        e.editedAtMsByFile[r.file] = editedAtMs;
      }
      if (!e.files.includes(r.file)) e.files.push(r.file);
      if (r.work_item_id && !e.workItems.includes(r.work_item_id)) e.workItems.push(r.work_item_id);
      // Every row in this cohort has identical scalar provenance.
      if (r.plan_slug && !e.planSlug) e.planSlug = r.plan_slug;
      if (r.intent && !e.intent) e.intent = r.intent;
      if (r.session_id && !e.sessionId) e.sessionId = r.session_id;
      if (r.contributor && !e.contributor) e.contributor = r.contributor;
    }
    return [...byProvenance.values()];
  } catch {
    return [];
  }
}

/** The Papercusp provenance a git-sync per-agent commit carries in its trailers (P-004). */
export interface ParsedCommitAttribution {
  /** The first `Papercusp-Agent:` author. */
  agent?: string;
  /** Every `Papercusp-Agent:` author, when a multi-author commit names more than one. */
  agents?: string[];
  workItems: string[];
  sessionId?: string;
  planSlug?: string;
}

/**
 * Parse the `Papercusp-Agent|Work-Item|Session|Plan:` trailers a git-sync per-agent commit
 * carries (written in run-git-sync.ts). Pure + testable. The commit↔work-item link travels in
 * git history via these; the post-sync reader (P-004) turns them + the commit's changed files
 * into git_sync_commit_attribution rows for the fast reverse-index the consumers query.
 */
export function parsePapercuspTrailers(commitBody: string): ParsedCommitAttribution {
  const out: ParsedCommitAttribution = { workItems: [] };
  const agents: string[] = [];
  for (const raw of (commitBody ?? '').split('\n')) {
    const m = /^(Papercusp-Agent|Papercusp-Work-Item|Papercusp-Session|Papercusp-Plan):\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const val = m[2].trim();
    // A multi-author commit (WI-6554700010029864) names several agents; the first is primary.
    if (m[1] === 'Papercusp-Agent') {
      if (!agents.includes(val)) agents.push(val);
      out.agent = agents[0];
      if (agents.length > 1) out.agents = [...agents];
    } else if (m[1] === 'Papercusp-Work-Item') out.workItems = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'Papercusp-Session') out.sessionId = val;
    else if (m[1] === 'Papercusp-Plan') out.planSlug = val;
  }
  return out;
}

/** One git_sync_commit_attribution row — the durable commit→work-item link (P-004). */
export interface CommitAttributionRow {
  workspaceId: string;
  harnessSlug: string;
  /** 'superproject', or the submodule path relative to the top-level superproject; `file` is relative to this repo. */
  repo: string;
  commitSha: string;
  file: string;
  agentId?: string;
  sessionId?: string;
  workItemId?: string;
  planSlug?: string;
  /** Committer date of `commitSha` (ISO 8601). `ts` is when the row was recorded, which can lag by hours. */
  committedAt?: string;
}

/**
 * Bulk-insert git_sync_commit_attribution rows (P-004) — one per (file × work-item) for a
 * git-sync commit. DETERMINISTIC + best-effort (D-006): raw SQL, never throws. Powers the
 * doc-drift "which work-item changed this code?" join (P-005) + the merge-resolver authorship
 * context (P-006).
 */
export async function recordCommitAttribution(rows: CommitAttributionRow[]): Promise<void> {
  try {
    if (!rows || rows.length === 0) return;
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.git_sync_commit_attribution
        (workspace_id, harness_slug, repo, commit_sha, file, agent_id, session_id, work_item_id, plan_slug, committed_at)
      SELECT * FROM unnest(
        ${rows.map((r) => r.workspaceId)}::text[],
        ${rows.map((r) => r.harnessSlug)}::text[],
        ${rows.map((r) => r.repo)}::text[],
        ${rows.map((r) => r.commitSha)}::text[],
        ${rows.map((r) => r.file)}::text[],
        ${rows.map((r) => r.agentId ?? null)}::text[],
        ${rows.map((r) => r.sessionId ?? null)}::text[],
        ${rows.map((r) => r.workItemId ?? null)}::text[],
        ${rows.map((r) => r.planSlug ?? null)}::text[],
        ${rows.map((r) => r.committedAt ?? null)}::timestamptz[]
      )
    `;
  } catch (error) {
    // best-effort: commit attribution must never affect git-sync — but a silent drop hid
    // an 85h attribution outage once (WI-6554700010018198), so leave a trace.
    console.warn(
      `[edit-attribution] git_sync_commit_attribution insert of ${rows?.length ?? 0} row(s) failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * P-005 (doc-drift attribution): the work-item(s) that recently changed the given CODE files,
 * read back from git_sync_commit_attribution. The doc-freshness sweep calls this for a drifted
 * doc's anchored files so the doc-steward learns WHY the code changed (D-006: derived, no extra
 * agent tool call). Best-effort — returns a `file → workItemIds` map, empty on any error.
 * `lookbackHours` bounds it (default 14 days — the "what recently shaped this code" window).
 */
export async function lookupDriftCauseWorkItems(
  files: string[],
  opts: { harnessSlug?: string; lookbackHours?: number } = {},
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const uniq = [...new Set((files ?? []).filter(Boolean))];
    if (uniq.length === 0) return out;
    const { sql } = getOrgPg();
    const rows = await sql<{ file: string; work_item_id: string }[]>`
      SELECT DISTINCT file, work_item_id
        FROM harness_shared.git_sync_commit_attribution
       WHERE file = ANY(${uniq})
         AND work_item_id IS NOT NULL
         ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
         AND coalesce(committed_at, ts) >= now() - make_interval(hours => ${opts.lookbackHours ?? 24 * 14})
    `;
    for (const r of rows) {
      const arr = out.get(r.file) ?? [];
      if (!arr.includes(r.work_item_id)) arr.push(r.work_item_id);
      out.set(r.file, arr);
    }
    return out;
  } catch {
    return out;
  }
}
