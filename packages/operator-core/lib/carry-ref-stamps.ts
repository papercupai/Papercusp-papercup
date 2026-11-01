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
 *      token moved or could not be resolved. Unresolved is not treated as deletion:
 *      the underlying resolvers also use null for temporarily unreadable sources.
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
import { isAbsolute, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import type { DepStamp } from './freshness/index';
import {
  resolveCurrentTokens,
  resolveFileTokensWithProvenance,
  splitDep,
  type FreshnessFileRootSource,
  type FreshnessResolverCtx,
} from './freshness/resolvers';

/** At most this many references are stamped per checkpoint (first appearance wins). */
export const CARRY_REF_MAX = 24;
/** At most this many stamped references are re-resolved per delivery, across all sources. */
export const CARRY_REF_DELIVERY_MAX = 48;
/** Re-resolution budget for one delivery. Past it the block says so instead of guessing. */
export const CARRY_REF_DELIVERY_TIMEOUT_MS = 4_000;
/** Bound on write-time stamping, which sits on the checkpoint write path. */
export const CARRY_REF_STAMP_TIMEOUT_MS = 2_000;

/** A carried file stamp keeps the checkout that supplied its baseline hash. */
export interface CarryRefStamp extends DepStamp {
  sourceRoot?: string;
  sourceRootKind?: FreshnessFileRootSource;
}

export interface CarryRefFileRoot {
  root: string | null;
  rootSource: FreshnessFileRootSource | null;
}

export interface CarryRefResolution {
  tokens: Map<string, string | null>;
  /** Keyed by the full file dependency tag, e.g. file:packages/x.ts. */
  fileRoots: Map<string, CarryRefFileRoot>;
}

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
export async function resolveCarryRefTokensWithProvenance(
  deps: readonly string[],
  ctx: FreshnessResolverCtx,
): Promise<CarryRefResolution> {
  const out = new Map<string, string | null>();
  const fileRefs: string[] = [];
  const declarable: string[] = [];
  const byLocal = new Map<'decision' | 'fact', string[]>();
  for (const dep of deps) {
    const parts = splitDep(dep);
    if (parts?.kind === 'file') {
      fileRefs.push(parts.ref);
      continue;
    }
    if (parts && (parts.kind === 'decision' || parts.kind === 'fact')) {
      const list = byLocal.get(parts.kind) ?? [];
      list.push(parts.ref);
      byLocal.set(parts.kind, list);
    } else {
      declarable.push(dep);
    }
  }
  const [base, decisions, facts, files] = await Promise.all([
    declarable.length > 0 ? resolveCurrentTokens(declarable, ctx).catch(() => allNull(declarable)) : new Map<string, string | null>(),
    resolveDecisionTokens(byLocal.get('decision') ?? [], ctx),
    resolveFactTokens(byLocal.get('fact') ?? [], ctx),
    fileRefs.length > 0
      ? resolveFileTokensWithProvenance(fileRefs, ctx).catch(() => ({
          tokens: allNull(fileRefs),
          root: null,
          rootSource: null,
        }))
      : Promise.resolve({ tokens: new Map<string, string | null>(), root: null, rootSource: null }),
  ]);
  for (const dep of declarable) out.set(dep, base.get(dep) ?? null);
  for (const [ref, token] of decisions) out.set(`decision:${ref}`, token);
  for (const [ref, token] of facts) out.set(`fact:${ref}`, token);
  const fileRoots = new Map<string, CarryRefFileRoot>();
  for (const ref of fileRefs) {
    const dep = `file:${ref}`;
    out.set(dep, files.tokens.get(ref) ?? null);
    fileRoots.set(dep, { root: files.root, rootSource: files.rootSource });
  }
  return { tokens: out, fileRoots };
}

export const resolveCarryRefTokens: CarryRefResolver = async (deps, ctx) =>
  (await resolveCarryRefTokensWithProvenance(deps, ctx)).tokens;

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
}): Promise<CarryRefStamp[]> {
  if (!input.workspaceId) return [];
  const deps = extractCarryRefDeps(input.text, { exclude: input.exclude });
  if (deps.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctx = { workspaceId: input.workspaceId, harness: input.harness };
    const resolution = await Promise.race([
      input.resolve
        ? input.resolve(deps, ctx).then((tokens) => ({ tokens, fileRoots: new Map<string, CarryRefFileRoot>() }))
        : resolveCarryRefTokensWithProvenance(deps, ctx),
      new Promise<CarryRefResolution>((resolveResult) => {
        timer = setTimeout(
          () => resolveResult({ tokens: new Map(), fileRoots: new Map() }),
          input.timeoutMs ?? CARRY_REF_STAMP_TIMEOUT_MS,
        );
      }),
    ]);
    const at = input.now ?? Date.now();
    const stamps: CarryRefStamp[] = [];
    for (const dep of deps) {
      const token = resolution.tokens.get(dep);
      if (typeof token !== 'string' || token.length === 0) continue;
      const fileRoot = resolution.fileRoots.get(dep);
      stamps.push({
        dep,
        token,
        at,
        ...(fileRoot?.root ? { sourceRoot: fileRoot.root } : {}),
        ...(fileRoot?.rootSource ? { sourceRootKind: fileRoot.rootSource } : {}),
      });
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
  fresh: readonly CarryRefStamp[] | undefined,
  priorDeps: unknown,
): CarryRefStamp[] {
  if (!storedNote) return [];
  const out: CarryRefStamp[] = [...(fresh ?? [])];
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
export function parseCarryRefStamps(rawDeps: unknown): CarryRefStamp[] {
  if (!rawDeps || typeof rawDeps !== 'object') return [];
  const refs = (rawDeps as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return [];
  const out: CarryRefStamp[] = [];
  for (const s of refs) {
    if (!s || typeof s !== 'object') continue;
    const { dep, token, at, sourceRoot, sourceRootKind } = s as Partial<CarryRefStamp>;
    if (typeof dep !== 'string' || dep.length === 0 || typeof token !== 'string') continue;
    const root =
      typeof sourceRoot === 'string' && sourceRoot.length <= 2_048 && isAbsolute(sourceRoot)
        ? sourceRoot
        : undefined;
    const rootKind =
      sourceRootKind === 'harness-root' || sourceRootKind === 'canonical-repo' || sourceRootKind === 'explicit-root'
        ? sourceRootKind
        : undefined;
    out.push({
      dep,
      token,
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      ...(root ? { sourceRoot: root } : {}),
      ...(rootKind ? { sourceRootKind: rootKind } : {}),
    });
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
  refStamps: readonly CarryRefStamp[] | undefined,
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
  kind: 'changed' | 'unverified' | 'source-shift';
  was: string;
  now: string | null;
  /** Which checkpoint carried the reference (e.g. "loop note", "WI-1 checkpoint"). */
  source: string;
  stampedAt: number;
  stampedRoot: string | null;
  stampedRootKind: FreshnessFileRootSource | null;
  currentRoot: string | null;
  currentRootKind: FreshnessFileRootSource | null;
  rootChanged: boolean;
}

/** Compare stamps with current tokens. Unchanged references yield nothing. */
export function diffCarryRefStamps(
  stamps: readonly CarryRefStamp[],
  current: ReadonlyMap<string, string | null>,
  source: string,
  currentFileRoots: ReadonlyMap<string, CarryRefFileRoot> = new Map(),
): CarryRefChange[] {
  const out: CarryRefChange[] = [];
  for (const stamp of stamps) {
    if (!current.has(stamp.dep)) continue; // not re-resolved this pass (over the cap)
    const now = current.get(stamp.dep) ?? null;
    const currentRoot = currentFileRoots.get(stamp.dep) ?? null;
    const rootChanged = Boolean(
      stamp.sourceRoot &&
      currentRoot?.root &&
      resolve(stamp.sourceRoot) !== resolve(currentRoot.root),
    );
    const provenance = {
      stampedAt: stamp.at,
      stampedRoot: stamp.sourceRoot ?? null,
      stampedRootKind: stamp.sourceRootKind ?? null,
      currentRoot: currentRoot?.root ?? null,
      currentRootKind: currentRoot?.rootSource ?? null,
      rootChanged,
    };
    if (now === null) {
      out.push({ dep: stamp.dep, kind: 'unverified', was: stamp.token, now: null, source, ...provenance });
    } else if (now !== stamp.token || rootChanged) {
      out.push({
        dep: stamp.dep,
        kind: rootChanged ? 'source-shift' : 'changed',
        was: stamp.token,
        now,
        source,
        ...provenance,
      });
    }
  }
  return out;
}

function clipToken(token: string): string {
  return token.length > 48 ? `${token.slice(0, 45)}…` : token;
}

function describeChange(change: CarryRefChange): string {
  const parts = splitDep(change.dep);
  if (parts?.kind === 'file') {
    const stampedAt = change.stampedAt > 0 ? new Date(change.stampedAt).toISOString() : 'unknown';
    const stampedRoot = change.stampedRoot
      ? (change.stampedRootKind ?? 'source') + ' ' + change.stampedRoot
      : 'unknown (legacy stamp)';
    const currentRoot = change.currentRoot
      ? (change.currentRootKind ?? 'source') + ' ' + change.currentRoot
      : 'unavailable';
    const evidence =
      'stamped=' + stampedAt +
      '; baseline-root=' + stampedRoot +
      '; current-root=' + currentRoot;
    if (change.kind === 'unverified') {
      return `  ⚠ UNVERIFIED — ${change.dep} [${change.source}]: stamped ${clipToken(change.was)}; ${evidence}. The current source could not be resolved. It may be missing, moved, or temporarily unreadable; this is not evidence of deletion.`;
    }
    if (change.kind === 'source-shift') {
      const content = change.now === change.was
        ? 'content hash is unchanged'
        : `content hash differs (${clipToken(change.was)} → ${clipToken(change.now ?? '')})`;
      return `  ⚠ SOURCE ROOT CHANGED — ${change.dep} [${change.source}]: ${content}; ${evidence}.`;
    }
    return `  ↻ CHANGED — ${change.dep} [${change.source}]: ${clipToken(change.was)} → ${clipToken(change.now ?? '')} (${evidence})`;
  }
  if (change.kind === 'unverified') {
    return `  ⚠ UNVERIFIED — ${change.dep} [${change.source}]: stamped ${clipToken(change.was)}; the current source could not be resolved. It may be missing, moved, or temporarily unreadable; this is not evidence of deletion.`;
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
    `${n} ${n === 1 ? 'reference needs' : 'references need'} review ` +
    `(unchanged ones are not listed). Re-read these before acting on what the checkpoint says about them:`;
  return [head, ...changes.map(describeChange)].join('\n');
}

export interface CarryRefSource {
  /** Shown on each line, e.g. "loop note" or "WI-1 checkpoint". */
  label: string;
  stamps: readonly CarryRefStamp[];
  /** Harness owning these references; omitted sources inherit the caller's harness. */
  harness?: string | null;
}

/**
 * READ side, used by wake delivery and compaction recovery: re-resolve every stamped
 * reference (one batched resolution per source harness, bounded by the total
 * harness/reference pairs in {@link CARRY_REF_DELIVERY_MAX} and by
 * {@link CARRY_REF_DELIVERY_TIMEOUT_MS}) and render one line per changed or gone
 * reference. Returns null when nothing moved.
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
  const batches = new Map<string | null, { deps: string[]; seen: Set<string> }>();
  let dependencyCount = 0;
  for (const source of sources) {
    const harness = source.harness === undefined ? opts.harness : source.harness;
    const batch = batches.get(harness) ?? { deps: [], seen: new Set<string>() };
    batches.set(harness, batch);
    for (const stamp of source.stamps) {
      if (batch.seen.has(stamp.dep) || dependencyCount >= CARRY_REF_DELIVERY_MAX) continue;
      batch.seen.add(stamp.dep);
      batch.deps.push(stamp.dep);
      dependencyCount += 1;
    }
  }
  const resolutionBatches = [...batches.entries()].filter(([, batch]) => batch.deps.length > 0);
  const workspaceId = opts.workspaceId;
  if (dependencyCount === 0 || !workspaceId) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      Promise.all(resolutionBatches.map(async ([harness, batch]) => {
        const ctx = { workspaceId, harness };
        const resolution = opts.resolve
          ? { tokens: await opts.resolve(batch.deps, ctx), fileRoots: new Map<string, CarryRefFileRoot>() }
          : await resolveCarryRefTokensWithProvenance(batch.deps, ctx);
        return [harness, resolution] as const;
      })),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), opts.timeoutMs ?? CARRY_REF_DELIVERY_TIMEOUT_MS);
      }),
    ]);
    if (resolved === 'timeout') {
      return (
        `🔗 CARRIED REFERENCES — COULD NOT RE-CHECK at ${opts.where}: ${dependencyCount} stamped reference(s) did not ` +
        `resolve within ${opts.timeoutMs ?? CARRY_REF_DELIVERY_TIMEOUT_MS}ms. This is NOT evidence they are unchanged.`
      );
    }
    const currentBySourceHarness = new Map(resolved);
    const changes = sources.flatMap((source) => {
      const harness = source.harness === undefined ? opts.harness : source.harness;
      const current = currentBySourceHarness.get(harness);
      return current
        ? diffCarryRefStamps(source.stamps, current.tokens, source.label, current.fileRoots)
        : [];
    });
    return renderCarryRefChanges(changes, { where: opts.where, readAtIso: opts.readAtIso });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `🔗 CARRIED REFERENCES — COULD NOT RE-CHECK at ${opts.where}: ${why.slice(0, 200)}. This is NOT evidence they are unchanged.`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
