/**
 * Carry reference version stamps — plan carry-recheck-and-governed-memory-2026-10-14, P-002.
 *
 * A checkpoint (`loop:checkpoint` / `work_items:checkpoint`) is prose that cites things:
 * work items, plan decisions, facts, repo files. The cited thing can change after the
 * checkpoint is written, and the successor who reads the prose cannot tell. This module
 * closes that gap deterministically (D-001: no model call anywhere on this path):
 *
 *   1. WRITE — {@link extractCarryRefDeps} pulls the references out of the checkpoint text
 *      and {@link stampCarryRefs} records a version token for each one that resolves now.
 *      The stamps ride the existing `harness_shared.carry_notes.deps` payload under a
 *      separate `refs` key (D-003: no parallel store). They are deliberately NOT mixed
 *      into the author-declared `deps.stamps`, so the existing freshness verdict
 *      (`computeFreshness`) keeps its exact meaning.
 *   2. READ — at wake delivery and compaction recovery, {@link carryRefChangesBlock}
 *      re-resolves every stamped reference and renders ONE line per reference whose
 *      token moved or that no longer resolves. When nothing moved it returns null, so
 *      the delivery prints nothing.
 *
 * Token sources (each a version the source already keeps):
 *   - `work-item:<id>`            → `status@updated_ts` (the existing freshness resolver)
 *   - `file:<repo-relative path>` → `sha256:<16 hex>` of the bytes (existing resolver)
 *   - `decision:<slug>#D-NNN`     → `sha256:<16 hex>` of that decision's title + body
 *   - `fact:<key>`                → `live:<id>@<ms>`, or `retracted|superseded|evicted|expired:<id>`
 *
 * The `decision:` and `fact:` resolvers live here rather than in `DEP_RESOLVERS` on
 * purpose: that registry is also the set of kinds an author may DECLARE via
 * `dependsOn`, and it is rendered into two tool descriptions. Auto-extracted refs need
 * no new declarable surface.
 */

import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { DepStamp } from './freshness/index';
import { resolveCurrentTokens, splitDep, type FreshnessResolverCtx } from './freshness/resolvers';

/** At most this many references are stamped per checkpoint (first appearance wins). */
export const CARRY_REF_MAX = 24;
/** At most this many stamped references are re-resolved per delivery, across all sources. */
export const CARRY_REF_DELIVERY_MAX = 48;
/** Re-resolution budget for one delivery. Past it the block says so instead of guessing. */
export const CARRY_REF_DELIVERY_TIMEOUT_MS = 4_000;
/** Bound on write-time stamping, which sits on the checkpoint write path. */
export const CARRY_REF_STAMP_TIMEOUT_MS = 2_000;

const WORK_ITEM_REF = /\b(?:WI|EI)-\d{4,}\b/g;
const DECISION_REF = /\b(?:plan:)?([a-z0-9][a-z0-9-]*[a-z0-9])#(D-\d{3,})\b/gi;
const FACT_TOKEN_REF = /\bfact:([a-z0-9][a-z0-9._:/-]*[a-z0-9])/gi;
const FACT_TICK_REF = /\bfacts?\s+`([a-z0-9][a-z0-9._:/-]{1,118}[a-z0-9])`/gi;
const FILE_ROOTS = 'packages|apps|libs|scripts|plugins|orchestrator|papercusp-desktop|bin|docs';
const FILE_REF = new RegExp(
  `(?:^|[\\s\`'"(\\[])(?:papercusp/)?((?:${FILE_ROOTS})/[A-Za-z0-9_@./+-]+\\.[A-Za-z0-9]{1,8})(?=$|[\\s\`'"),:;\\]]|\\.(?:\\s|$))`,
  'g',
);

interface Found {
  dep: string;
  at: number;
}

/**
 * Deterministically extract the `kind:ref` tags a checkpoint text cites, in order of
 * first appearance, deduplicated, capped at {@link CARRY_REF_MAX}. `exclude` drops tags
 * that would only ever report the author's own write (a work item's checkpoint citing
 * its own id moves that item's `updated_ts` on every write).
 */
export function extractCarryRefDeps(
  text: string | null | undefined,
  opts: { exclude?: readonly string[]; max?: number } = {},
): string[] {
  if (!text) return [];
  const found: Found[] = [];
  for (const m of text.matchAll(WORK_ITEM_REF)) found.push({ dep: `work-item:${m[0].toUpperCase()}`, at: m.index ?? 0 });
  for (const m of text.matchAll(DECISION_REF)) {
    found.push({ dep: `decision:${m[1]!.toLowerCase()}#${m[2]!.toUpperCase()}`, at: m.index ?? 0 });
  }
  for (const m of text.matchAll(FACT_TOKEN_REF)) found.push({ dep: `fact:${m[1]!}`, at: m.index ?? 0 });
  for (const m of text.matchAll(FACT_TICK_REF)) found.push({ dep: `fact:${m[1]!}`, at: m.index ?? 0 });
  for (const m of text.matchAll(FILE_REF)) found.push({ dep: `file:${m[1]!}`, at: m.index ?? 0 });
  found.sort((a, b) => a.at - b.at);
  const exclude = new Set(opts.exclude ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  const max = opts.max ?? CARRY_REF_MAX;
  for (const f of found) {
    if (seen.has(f.dep) || exclude.has(f.dep)) continue;
    seen.add(f.dep);
    out.push(f.dep);
    if (out.length >= max) break;
  }
  return out;
}

function allNull(refs: readonly string[]): Map<string, string | null> {
  return new Map(refs.map((r) => [r, null]));
}

function shortSha(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/** `decision:<slug>#D-NNN` refs → token. Missing plan or decision id → null (gone). */
export async function resolveDecisionTokens(
  refs: readonly string[],
  ctx: FreshnessResolverCtx,
): Promise<Map<string, string | null>> {
  const out = allNull(refs);
  if (!ctx.workspaceId) return out;
  const parsed = new Map<string, { slug: string; id: string }>();
  for (const ref of refs) {
    const m = /^([a-z0-9][a-z0-9-]*)#(D-\d{3,})$/i.exec(ref);
    if (m) parsed.set(ref, { slug: m[1]!.toLowerCase(), id: m[2]!.toUpperCase() });
  }
  const slugs = [...new Set([...parsed.values()].map((p) => p.slug))];
  if (slugs.length === 0) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ plan_slug: string; harness_slug: string; decisions: unknown }[]>`
      SELECT plan_slug, harness_slug, decisions
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${ctx.workspaceId} AND plan_slug = ANY(${slugs})`;
    const bySlug = new Map<string, unknown>();
    for (const slug of slugs) {
      const matches = rows.filter((r) => r.plan_slug === slug);
      // A slug present in several harnesses resolves only through the note's own harness.
      const pick = matches.length === 1 ? matches[0] : matches.find((r) => r.harness_slug === ctx.harness);
      if (pick) bySlug.set(slug, pick.decisions);
    }
    for (const [ref, { slug, id }] of parsed) {
      const list = bySlug.get(slug);
      if (!Array.isArray(list)) continue;
      const decision = list.find(
        (d) => d && typeof d === 'object' && String((d as { id?: unknown }).id ?? '').toUpperCase() === id,
      ) as { title?: unknown; body?: unknown } | undefined;
      if (!decision) continue;
      out.set(ref, shortSha(`${String(decision.title ?? '')}\n${String(decision.body ?? '')}`));
    }
  } catch {
    /* leave unresolved */
  }
  return out;
}

/**
 * `fact:<key>` refs → token. A note cites a fact by key, not by scope, so the newest
 * live row with that key in the workspace is the one it means. Every row retracted,
 * superseded, evicted or expired → that state; the key never existed → null (gone).
 */
export async function resolveFactTokens(
  refs: readonly string[],
  ctx: FreshnessResolverCtx,
  nowMs: number = Date.now(),
): Promise<Map<string, string | null>> {
  const out = allNull(refs);
  if (!ctx.workspaceId) return out;
  const keys = [...new Set(refs)];
  if (keys.length === 0) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      {
        key: string;
        id: string | number;
        updated_at: Date | null;
        retracted_at: Date | null;
        superseded_at: Date | null;
        evicted_at: Date | null;
        expires_at: Date | null;
      }[]
    >`
      SELECT key, id, updated_at, retracted_at, superseded_at, evicted_at, expires_at
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ctx.workspaceId} AND key = ANY(${keys})
       ORDER BY updated_at DESC NULLS LAST, id DESC`;
    for (const key of keys) {
      const mine = rows.filter((r) => r.key === key);
      if (mine.length === 0) continue;
      const live = mine.find(
        (r) => !r.retracted_at && !r.superseded_at && !r.evicted_at && !(r.expires_at && r.expires_at.getTime() <= nowMs),
      );
      if (live) {
        out.set(key, `live:${live.id}@${live.updated_at ? live.updated_at.getTime() : 0}`);
        continue;
      }
      const top = mine[0]!;
      const state = top.retracted_at ? 'retracted' : top.superseded_at ? 'superseded' : top.evicted_at ? 'evicted' : 'expired';
      out.set(key, `${state}:${top.id}`);
    }
  } catch {
    /* leave unresolved */
  }
  return out;
}

/** Injectable resolution seam (tests). */
export type CarryRefResolver = (
  deps: readonly string[],
  ctx: FreshnessResolverCtx,
) => Promise<Map<string, string | null>>;

/**
 * Resolve `kind:ref` tags of the four carry-reference kinds to current tokens, batched
 * per kind. Never throws; an unresolvable tag maps to null.
 */
export const resolveCarryRefTokens: CarryRefResolver = async (deps, ctx) => {
  const out = new Map<string, string | null>();
  const declarable: string[] = [];
  const byLocal = new Map<'decision' | 'fact', string[]>();
  for (const dep of deps) {
    const parts = splitDep(dep);
    if (parts && (parts.kind === 'decision' || parts.kind === 'fact')) {
      const list = byLocal.get(parts.kind) ?? [];
      list.push(parts.ref);
      byLocal.set(parts.kind, list);
    } else {
      declarable.push(dep);
    }
  }
  const [base, decisions, facts] = await Promise.all([
    declarable.length > 0 ? resolveCurrentTokens(declarable, ctx).catch(() => allNull(declarable)) : new Map<string, string | null>(),
    resolveDecisionTokens(byLocal.get('decision') ?? [], ctx),
    resolveFactTokens(byLocal.get('fact') ?? [], ctx),
  ]);
  for (const dep of declarable) out.set(dep, base.get(dep) ?? null);
  for (const [ref, token] of decisions) out.set(`decision:${ref}`, token);
  for (const [ref, token] of facts) out.set(`fact:${ref}`, token);
  return out;
};

/**
 * WRITE side: stamp every reference the checkpoint text cites that resolves right now.
 * A reference that does not resolve at write time has no baseline to compare against,
 * so it is left out rather than stamped as gone. Never throws (→ `[]`).
 */
export async function stampCarryRefs(input: {
  text: string | null | undefined;
  workspaceId: string | null | undefined;
  harness: string | null;
  exclude?: readonly string[];
  now?: number;
  resolve?: CarryRefResolver;
  /** Bound on the resolution; a write never waits longer than this (→ `[]`). */
  timeoutMs?: number;
}): Promise<DepStamp[]> {
  if (!input.workspaceId) return [];
  const deps = extractCarryRefDeps(input.text, { exclude: input.exclude });
  if (deps.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tokens = await Promise.race([
      (input.resolve ?? resolveCarryRefTokens)(deps, {
        workspaceId: input.workspaceId,
        harness: input.harness,
      }),
      new Promise<Map<string, string | null>>((resolve) => {
        timer = setTimeout(() => resolve(new Map()), input.timeoutMs ?? CARRY_REF_STAMP_TIMEOUT_MS);
      }),
    ]);
    const at = input.now ?? Date.now();
    const stamps: DepStamp[] = [];
    for (const dep of deps) {
      const token = tokens.get(dep);
      if (typeof token === 'string' && token.length > 0) stamps.push({ dep, token, at });
    }
    return stamps;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The ref stamps a write should persist for the note it actually STORED. Fresh stamps
 * (computed from the incoming text) win; a prior stamp survives only while the stored
 * note still cites its reference (a row the merge transform carried forward keeps the
 * baseline it was first written against); a reference the note stopped citing is
 * dropped. `fresh === undefined` (a caller that did not stamp) keeps the cited priors.
 */
export function reconcileCarryRefStamps(
  storedNote: string | null,
  fresh: readonly DepStamp[] | undefined,
  priorDeps: unknown,
): DepStamp[] {
  if (!storedNote) return [];
  const out = [...(fresh ?? [])];
  const have = new Set(out.map((s) => s.dep));
  const cited = new Set(extractCarryRefDeps(storedNote, { max: Number.MAX_SAFE_INTEGER }));
  for (const prior of parseCarryRefStamps(priorDeps)) {
    if (have.has(prior.dep) || !cited.has(prior.dep) || out.length >= CARRY_REF_MAX) continue;
    have.add(prior.dep);
    out.push(prior);
  }
  return out;
}

/** Read the `refs` stamps out of a raw `carry_notes.deps` payload. Malformed → `[]`. */
export function parseCarryRefStamps(rawDeps: unknown): DepStamp[] {
  if (!rawDeps || typeof rawDeps !== 'object') return [];
  const refs = (rawDeps as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return [];
  const out: DepStamp[] = [];
  for (const s of refs) {
    if (!s || typeof s !== 'object') continue;
    const { dep, token, at } = s as Partial<DepStamp>;
    if (typeof dep !== 'string' || dep.length === 0 || typeof token !== 'string') continue;
    out.push({ dep, token, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
  }
  return out;
}

/**
 * Merge a write's ref stamps into the `deps` column value. `refStamps === undefined`
 * carries the prior stamps forward; `[]` removes them. The declared payload (`v`,
 * `stamps`, `recomputed`) passes through untouched. Returns null only when there is
 * neither a declared payload nor any ref stamp.
 */
export function mergeCarryRefStampsIntoDeps(
  depsCol: unknown,
  refStamps: readonly DepStamp[] | undefined,
  priorDeps: unknown,
): unknown {
  const refs = refStamps === undefined ? parseCarryRefStamps(priorDeps) : [...refStamps];
  const base = depsCol && typeof depsCol === 'object' ? { ...(depsCol as Record<string, unknown>) } : null;
  if (refs.length === 0) {
    if (!base) return null;
    delete base.refs;
    return base;
  }
  return { ...(base ?? { v: 1, stamps: [] }), refs };
}

export interface CarryRefChange {
  dep: string;
  kind: 'changed' | 'gone';
  was: string;
  now: string | null;
  /** Which checkpoint carried the reference (e.g. "loop note", "WI-1 checkpoint"). */
  source: string;
}

/** Compare stamps with current tokens. Unchanged references yield nothing. */
export function diffCarryRefStamps(
  stamps: readonly DepStamp[],
  current: ReadonlyMap<string, string | null>,
  source: string,
): CarryRefChange[] {
  const out: CarryRefChange[] = [];
  for (const stamp of stamps) {
    if (!current.has(stamp.dep)) continue; // not re-resolved this pass (over the cap)
    const now = current.get(stamp.dep) ?? null;
    if (now === null) out.push({ dep: stamp.dep, kind: 'gone', was: stamp.token, now: null, source });
    else if (now !== stamp.token) out.push({ dep: stamp.dep, kind: 'changed', was: stamp.token, now, source });
  }
  return out;
}

function clipToken(token: string): string {
  return token.length > 48 ? `${token.slice(0, 45)}…` : token;
}

function describeChange(change: CarryRefChange): string {
  const parts = splitDep(change.dep);
  if (change.kind === 'gone') {
    return `  ✗ GONE — ${change.dep} [${change.source}]: stamped ${clipToken(change.was)}; it no longer resolves (deleted, moved, or unreadable right now)`;
  }
  if (parts?.kind === 'work-item') {
    const was = change.was.split('@')[0] ?? change.was;
    const now = (change.now ?? '').split('@')[0] ?? '';
    const what = was === now ? `${now} (updated since)` : `${was} → ${now}`;
    return `  ↻ CHANGED — ${change.dep} [${change.source}]: ${what}`;
  }
  if (parts?.kind === 'fact' && !(change.now ?? '').startsWith('live:')) {
    return `  ↻ CHANGED — ${change.dep} [${change.source}]: now ${(change.now ?? '').split(':')[0]}`;
  }
  return `  ↻ CHANGED — ${change.dep} [${change.source}]: ${clipToken(change.was)} → ${clipToken(change.now ?? '')}`;
}

/** Render the changes, or null when there are none (an unchanged carry prints nothing). */
export function renderCarryRefChanges(
  changes: readonly CarryRefChange[],
  opts: { where: string; readAtIso?: string },
): string | null {
  if (changes.length === 0) return null;
  const n = changes.length;
  const head =
    `🔗 CARRIED REFERENCES re-checked at ${opts.where}${opts.readAtIso ? ` (readAt=${opts.readAtIso})` : ''} — ` +
    `${n} ${n === 1 ? 'reference has' : 'references have'} moved since the checkpoint was written ` +
    `(unchanged ones are not listed). Re-read these before acting on what the checkpoint says about them:`;
  return [head, ...changes.map(describeChange)].join('\n');
}

export interface CarryRefSource {
  /** Shown on each line, e.g. "loop note" or "WI-1 checkpoint". */
  label: string;
  stamps: readonly DepStamp[];
}

/**
 * READ side, used by wake delivery and compaction recovery: re-resolve every stamped
 * reference (one batched resolution across all sources, bounded by
 * {@link CARRY_REF_DELIVERY_MAX} and {@link CARRY_REF_DELIVERY_TIMEOUT_MS}) and render
 * one line per changed or gone reference. Returns null when nothing moved.
 */
export async function carryRefChangesBlock(
  sources: readonly CarryRefSource[],
  opts: {
    workspaceId: string | null | undefined;
    harness: string | null;
    where: string;
    readAtIso?: string;
    resolve?: CarryRefResolver;
    timeoutMs?: number;
  },
): Promise<string | null> {
  const deps: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const stamp of source.stamps) {
      if (seen.has(stamp.dep) || deps.length >= CARRY_REF_DELIVERY_MAX) continue;
      seen.add(stamp.dep);
      deps.push(stamp.dep);
    }
  }
  if (deps.length === 0 || !opts.workspaceId) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await Promise.race([
      (opts.resolve ?? resolveCarryRefTokens)(deps, { workspaceId: opts.workspaceId, harness: opts.harness }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), opts.timeoutMs ?? CARRY_REF_DELIVERY_TIMEOUT_MS);
      }),
    ]);
    if (current === 'timeout') {
      return (
        `🔗 CARRIED REFERENCES — COULD NOT RE-CHECK at ${opts.where}: ${deps.length} stamped reference(s) did not ` +
        `resolve within ${opts.timeoutMs ?? CARRY_REF_DELIVERY_TIMEOUT_MS}ms. This is NOT evidence they are unchanged.`
      );
    }
    const changes = sources.flatMap((s) => diffCarryRefStamps(s.stamps, current, s.label));
    return renderCarryRefChanges(changes, { where: opts.where, readAtIso: opts.readAtIso });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `🔗 CARRIED REFERENCES — COULD NOT RE-CHECK at ${opts.where}: ${why.slice(0, 200)}. This is NOT evidence they are unchanged.`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
