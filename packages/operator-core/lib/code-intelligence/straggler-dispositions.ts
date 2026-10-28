/**
 * R-11 straggler-dispositions instrument — code-intel-delivery-and-outcomes-2026-10-26
 * P-016 (D-006, D-008, D-009, D-014).
 *
 * R-11 enumerates the code-intel straggler plan items that must reach a terminal
 * disposition before this plan ships: each one is `done`, or `dropped` with a drop note
 * naming exactly one disposition class whose evidence resolves. This instrument reads
 * those items from the plan store and grades them.
 *
 * Drop-note grammar (the ` — note: ` suffix that plans:set-status appends, matched with
 * the shared NOTE_SUFFIX_RE):
 *   - `superseded-by <ref>` / `obligations-moved-to <ref>`, where <ref> is
 *     `<plan-slug>#P-NNN`, `WI-N` or `EI-N`. The ref must resolve, must not be dropped,
 *     and must not cycle when followed. It must "carry the obligation"; the mechanical
 *     proxy is that the target's own text names the source ref in full.
 *   - `abandoned: <one-sentence reason>`. The source ref must appear in this plan's
 *     ## Now text (what will not exist), per D-014.
 * Any other status (todo, wip, blocked, needs-human) fails. A source that could not be
 * read yields unknown, never a pass.
 *
 * code-intel-reuse-signals-2026-10-21#P-012 is held until phase 1 lands and is
 * excluded by name (R-11 verification method).
 */
import { NOTE_SUFFIX_RE } from '@papercusp/plan-parser';
import type { Sql } from 'postgres';

export const STRAGGLER_DISPOSITIONS_INSTRUMENT_KEY = 'code-intel:straggler-dispositions';
export const STRAGGLER_SUBJECT_PLAN = 'code-intel-delivery-and-outcomes-2026-10-26';
export const STRAGGLER_HARNESS = 'papercusp';
export const STRAGGLER_EXCLUDED_REF = 'code-intel-reuse-signals-2026-10-21#P-012';

const REUSE = 'code-intel-reuse-signals-2026-10-21';
const NATIVE = 'native-code-intelligence-ecosystem-and-dream-2026-10-09';
const HARDENING = 'gitnexus-selective-hardening-and-comparison-2026-09-13';
const OPTIONAL = 'native-code-intelligence-optional-evaluations-2026-10-15';

/** Exactly the R-11 list, in its order. */
export const STRAGGLER_ITEMS: readonly string[] = Object.freeze([
  `${REUSE}#P-010`, `${REUSE}#P-019`,
  `${NATIVE}#P-026`, `${NATIVE}#P-027`, `${NATIVE}#P-033`,
  `${HARDENING}#P-009`,
  `${OPTIONAL}#P-001`, `${OPTIONAL}#P-002`, `${OPTIONAL}#P-003`, `${OPTIONAL}#P-004`, `${OPTIONAL}#P-005`,
]);

const DAY_MS = 86_400_000;
const MAX_FETCH_ROUNDS = 6;
const REF_RE = /^(?:[a-z0-9][a-z0-9-]*[a-z0-9]#P-\d{3,}|(?:WI|EI)-\d+)$/;
const CLASS_TOKEN_RE = /\b(?:superseded-by|obligations-moved-to)\b|\babandoned:/g;
const MOVED_RE = /\b(superseded-by|obligations-moved-to)\s+(\S+)/;

export type MovedClass = 'superseded-by' | 'obligations-moved-to';
export type Disposition =
  | { ok: true; cls: MovedClass; ref: string }
  | { ok: true; cls: 'abandoned'; reason: string }
  | { ok: false; error: string };

/** The drop note carried in an item's text, or null when there is none. */
export function dropNote(text: string): string | null {
  const m = NOTE_SUFFIX_RE.exec(text);
  if (!m) return null;
  const note = m[0].replace(/^\s*—\s*note:\s*/, '').trim();
  return note || null;
}

/** Parse a drop note into exactly one disposition class. */
export function parseDisposition(note: string | null): Disposition {
  if (!note) return { ok: false, error: 'dropped with no note, so no disposition class' };
  const classes = note.match(CLASS_TOKEN_RE) ?? [];
  if (classes.length === 0) return { ok: false, error: 'drop note names no disposition class' };
  if (classes.length > 1) return { ok: false, error: `drop note names ${classes.length} disposition classes; exactly one is required` };
  if (classes[0] !== 'abandoned:') {
    const moved = MOVED_RE.exec(note);
    if (!moved) return { ok: false, error: `${classes[0]} names no ref` };
    const ref = moved[2].replace(/[.,;:)\]]+$/, '');
    if (!REF_RE.test(ref)) return { ok: false, error: `${moved[1]} ref '${ref}' is not <plan-slug>#P-NNN, WI-N or EI-N` };
    return { ok: true, cls: moved[1] as MovedClass, ref };
  }
  const reason = /\babandoned:\s*(.*)$/.exec(note)?.[1]?.trim() ?? '';
  if (!reason) return { ok: false, error: 'abandoned drop has no reason' };
  if ((reason.match(/[.!?](?=\s|$)/g) ?? []).length > 1) return { ok: false, error: 'abandoned reason is more than one sentence' };
  return { ok: true, cls: 'abandoned', reason };
}

export interface RefTarget { status: string; text: string }

export interface StragglerSnapshot {
  /** Keyed by `<plan-slug>#P-NNN` or `WI-N` / `EI-N`. */
  targets: ReadonlyMap<string, RefTarget>;
  /** Plan slugs and work-item ids whose source was read successfully (found or not). */
  queried: ReadonlySet<string>;
  /** This plan's ## Now text, or null when the subject plan could not be read. */
  nowText: string | null;
}

export interface StragglerFinding { ref: string; status: string | null; disposition: string | null; problem: string | null; unknown: string | null }

export interface StragglerScore {
  verdict: 'healthy' | 'broken' | 'unknown';
  total: number;
  disposed: number;
  findings: StragglerFinding[];
}

function sourceKey(ref: string): string {
  const hash = ref.indexOf('#');
  return hash >= 0 ? ref.slice(0, hash) : ref;
}

type Lookup = { state: 'found'; target: RefTarget } | { state: 'missing' } | { state: 'unreadable' };

function lookup(snap: StragglerSnapshot, ref: string): Lookup {
  if (!snap.queried.has(sourceKey(ref))) return { state: 'unreadable' };
  const target = snap.targets.get(ref);
  return target ? { state: 'found', target } : { state: 'missing' };
}

/** Check a superseded-by / obligations-moved-to ref; returns a problem, an unknown, or neither. */
function checkMovedRef(snap: StragglerSnapshot, source: string, d: { cls: MovedClass; ref: string }): { problem?: string; unknown?: string } {
  const first = lookup(snap, d.ref);
  if (first.state === 'unreadable') return { unknown: `${d.cls} ref ${d.ref} could not be read` };
  if (first.state === 'missing') return { problem: `${d.cls} ref ${d.ref} does not resolve` };
  if (first.target.status === 'dropped') {
    // Follow the chain only to name a cycle; a dropped target fails either way.
    const visited = new Set([source, d.ref]);
    let cur: RefTarget = first.target;
    for (;;) {
      const next = parseDisposition(dropNote(cur.text));
      if (!next.ok || next.cls === 'abandoned') break;
      if (visited.has(next.ref)) return { problem: `${d.cls} ref ${d.ref} forms a cycle through ${next.ref}` };
      visited.add(next.ref);
      const hop = lookup(snap, next.ref);
      if (hop.state !== 'found' || hop.target.status !== 'dropped') break;
      cur = hop.target;
    }
    return { problem: `${d.cls} ref ${d.ref} points at a dropped item` };
  }
  if (!first.target.text.includes(source)) {
    return { problem: `${d.cls} ref ${d.ref} does not name ${source}, so it does not carry the obligation` };
  }
  return {};
}

/** Grade every enumerated straggler. Pure over the snapshot. */
export function scoreStragglerDispositions(snap: StragglerSnapshot, items: readonly string[] = STRAGGLER_ITEMS): StragglerScore {
  const findings: StragglerFinding[] = items.map((ref) => {
    const found = lookup(snap, ref);
    if (found.state === 'unreadable') return { ref, status: null, disposition: null, problem: null, unknown: `plan ${sourceKey(ref)} could not be read` };
    if (found.state === 'missing') return { ref, status: null, disposition: null, problem: 'enumerated straggler item not found', unknown: null };
    const { status, text } = found.target;
    if (status === 'done') return { ref, status, disposition: 'done', problem: null, unknown: null };
    if (status !== 'dropped') return { ref, status, disposition: null, problem: `still ${status}`, unknown: null };
    const d = parseDisposition(dropNote(text));
    if (!d.ok) return { ref, status, disposition: null, problem: d.error, unknown: null };
    if (d.cls === 'abandoned') {
      if (snap.nowText === null) return { ref, status, disposition: 'abandoned', problem: null, unknown: `${STRAGGLER_SUBJECT_PLAN} ## Now could not be read` };
      return snap.nowText.includes(ref)
        ? { ref, status, disposition: 'abandoned', problem: null, unknown: null }
        : { ref, status, disposition: 'abandoned', problem: `abandoned drop is not listed in ${STRAGGLER_SUBJECT_PLAN} ## Now`, unknown: null };
    }
    const check = checkMovedRef(snap, ref, d);
    return { ref, status, disposition: `${d.cls} ${d.ref}`, problem: check.problem ?? null, unknown: check.unknown ?? null };
  });
  const disposed = findings.filter(f => f.disposition !== null && !f.problem && !f.unknown).length;
  const verdict = findings.some(f => f.problem) ? 'broken' : findings.some(f => f.unknown) ? 'unknown' : 'healthy';
  return { verdict, total: items.length, disposed, findings };
}

export function summarizeStragglerScore(s: StragglerScore): string {
  const bad = s.findings.filter(f => f.problem).map(f => `${f.ref}: ${f.problem}`);
  const unk = s.findings.filter(f => f.unknown).map(f => `${f.ref}: ${f.unknown}`);
  return [
    `${s.disposed}/${s.total} stragglers disposed (${STRAGGLER_EXCLUDED_REF} excluded by name).`,
    bad.length ? `Broken: ${bad.join('; ')}.` : '',
    unk.length ? `Unknown: ${unk.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
}

/** The `## Now` section of a plan body, or '' when absent. */
export function nowSection(content: string | null | undefined): string {
  if (!content) return '';
  const start = content.search(/^## Now\b/m);
  if (start < 0) return '';
  const rest = content.slice(start + 1);
  const end = rest.search(/^## /m);
  return end < 0 ? content.slice(start) : content.slice(start, start + 1 + end);
}

type PlanRowLite = { plan_slug: string; items: unknown; content: string | null; now_state: string | null; now_next: string | null; now_note: string | null };
type WorkItemLite = { feature_id: string; status: string | null; text: string | null };

/** Read the stragglers plus every ref they lead to, to a bounded fixed point. */
export async function readStragglerSnapshot(sql: Sql, workspaceId: string): Promise<StragglerSnapshot> {
  const targets = new Map<string, RefTarget>();
  const queried = new Set<string>();
  let nowText: string | null = null;
  let wantPlans = new Set<string>([...STRAGGLER_ITEMS.map(sourceKey), STRAGGLER_SUBJECT_PLAN]);
  let wantWorkItems = new Set<string>();
  for (let round = 0; round < MAX_FETCH_ROUNDS && (wantPlans.size || wantWorkItems.size); round++) {
    if (wantPlans.size) {
      const slugs = [...wantPlans];
      const rows = await sql<PlanRowLite[]>`
        SELECT plan_slug, items, content, now_state, now_next, now_note FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${STRAGGLER_HARNESS} AND plan_slug = ANY(${slugs})`;
      for (const slug of slugs) queried.add(slug);
      for (const row of rows) {
        for (const it of Array.isArray(row.items) ? row.items as { id?: unknown; status?: unknown; text?: unknown }[] : []) {
          if (typeof it?.id === 'string') targets.set(`${row.plan_slug}#${it.id}`, { status: String(it.status ?? ''), text: String(it.text ?? '') });
        }
        if (row.plan_slug === STRAGGLER_SUBJECT_PLAN) {
          nowText = [row.now_state, row.now_next, row.now_note, nowSection(row.content)].filter(Boolean).join('\n');
        }
      }
    }
    if (wantWorkItems.size) {
      const ids = [...wantWorkItems];
      const rows = await sql<WorkItemLite[]>`
        SELECT feature_id, status, concat_ws(' ', title, summary, payload->>'body') AS text FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
      for (const id of ids) queried.add(id);
      for (const row of rows) targets.set(row.feature_id, { status: String(row.status ?? ''), text: String(row.text ?? '') });
    }
    wantPlans = new Set();
    wantWorkItems = new Set();
    for (const t of targets.values()) {
      if (t.status !== 'dropped') continue;
      const d = parseDisposition(dropNote(t.text));
      if (!d.ok || d.cls === 'abandoned') continue;
      const key = sourceKey(d.ref);
      if (queried.has(key)) continue;
      (d.ref.includes('#') ? wantPlans : wantWorkItems).add(key);
    }
  }
  return { targets, queried, nowText };
}

/**
 * The scorer grades in rubric terms (healthy / broken / unknown); the rescore ledger records
 * pass / fail / unknown. Map explicitly so a scorer verdict never leaks into the ledger shape.
 */
export function stragglerRescoreVerdict(verdict: StragglerScore['verdict']): 'pass' | 'fail' | 'unknown' {
  return verdict === 'healthy' ? 'pass' : verdict === 'broken' ? 'fail' : 'unknown';
}

/** Rubric-instrument rescore adapter for {@link STRAGGLER_DISPOSITIONS_INSTRUMENT_KEY}. */
export function codeIntelStragglerDispositionsRescore() {
  return {
    windowMs: DAY_MS,
    unit: 'count' as const,
    scope: 'workspace' as const,
    resolve: async (window: { workspaceId: string }) => {
      if (!window.workspaceId.trim()) return { verdict: 'unknown' as const, detail: 'Exact workspace required.' };
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const sql = getOrgPg().sql as unknown as Sql;
        const score = scoreStragglerDispositions(await readStragglerSnapshot(sql, window.workspaceId));
        return { verdict: stragglerRescoreVerdict(score.verdict), detail: summarizeStragglerScore(score), value: score.disposed };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { verdict: 'unknown' as const, detail: `straggler read failed (${msg.slice(0, 200)})` };
      }
    },
  };
}
