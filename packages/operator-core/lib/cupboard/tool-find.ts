/**
 * tool-find — hybrid (lexical + semantic) search over the tool catalog. The
 * intent-aware upgrade to the lexical-only `searchTools` (tools-search.ts) and
 * to omp's keyword-only `search_tool_bm25`: it matches by MEANING, so
 * "feature flag" finds `flags:*` and "spawn a worker" finds `cup:spawn` even
 * when the query words don't lexically appear in the tool text. Unlike omp's
 * native search it is operator-side, so it works for Claude/Codex too.
 * (tool-discovery-for-weak-models-2026-06-30 WS3.)
 *
 * Fusion pins explicit names and blends all other candidates. tools-search.ts
 * retains field weights because an explicit NAME match must ALWAYS outrank a
 * semantically-similar sibling (you don't want `coord:orient` buried under
 * `coord:glance`). So:
 *   - explicit colon-form names lead, in request order;
 *   - non-exact candidates blend query-normalized lexical relevance and floored
 *     cosine before truncation, so weak keyword hits cannot crowd out recall.
 *
 * The embedder + corpus embeddings are INJECTED (a one-time boot index over the
 * full tool catalog). With neither, it degrades gracefully to lexical-only — the
 * exact behavior of `searchTools` — so the tool is always functional.
 *
 * Pure + unit-testable; the route/tool wiring does the IO (corpus assembly via
 * `collectToolMeta`/`resolveToolEntries`, embeddings via `buildQueryEmbedder`).
 */
import type { ToolDiscoveryEntry } from './tools-discovery';
import { scoreTool, searchTools } from './tools-search';

export type Embedder = (text: string) => Promise<number[]>;

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for degenerate
 * input, and 0 for MISMATCHED WIDTHS.
 *
 * ⚠ It used to compute over `Math.min(a.length, b.length)` — silently scoring
 * the common PREFIX of two vectors from different embedding spaces. That is the
 * worst available behaviour: a 384-d index vector against a 768-d query returns
 * a perfectly plausible number in [-1, 1], so a whole semantic leg can rank on
 * arithmetic that means nothing, with no error and nothing in the output that
 * looks wrong. The docstring already promised equal length; only the code was
 * lenient about it (P-019).
 *
 * Comparing prefixes is never the intent — two spaces of different width are
 * not comparable at all, so "no signal" (0) is the only honest answer. The
 * caller detects the mismatch up front and skips the leg entirely; this is
 * defence in depth for any other caller.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  const n = a.length;
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ToolFindHit {
  /** Tool MCP name, e.g. `flags:set`. */
  tool: string;
  description: string | null;
  /** Compact arg-schema text (`key:type description; …`); null for a no-arg tool. */
  argSchema: string | null;
  category: string;
  /** Which leg(s) surfaced it. */
  via: 'lexical' | 'semantic' | 'both';
  /** Cosine for a semantic/both hit (for debugging / threshold tuning); null for lexical-only. */
  cosine: number | null;
}

export type ToolFindQueryEmbeddingOutcome =
  | 'used'
  | 'timeout'
  | 'failed'
  | 'invalid-vector'
  | 'width-mismatch';

export interface ToolFindOptions {
  /** Max results (default 10). */
  limit?: number;
  /** Query embedder. Absent/null → lexical-only (graceful degrade). */
  embedder?: Embedder | null;
  /** Precomputed corpus embeddings keyed by tool name (the boot index). Absent → lexical-only. */
  embeddings?: ReadonlyMap<string, readonly number[]> | null;
  /** Minimum cosine to admit a SEMANTIC-only hit (default 0.35). The floor in floored-union. */
  minCosine?: number;
  /**
   * Bound the per-query embed call. A resolved embedder can still stall (for
   * example, an OpenAI fetch without a client timeout), so discovery must
   * degrade to lexical-only instead of holding the whole tool call open.
   * Defaults to the interactive 4s budget; pass 0 to preserve an unbounded
   * call for an explicit batch caller.
   */
  embedTimeoutMs?: number;
  /** Reports the actual outcome of this call's semantic query leg. */
  onQueryEmbeddingOutcome?: (outcome: ToolFindQueryEmbeddingOutcome) => void;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_COSINE = 0.35;
const DEFAULT_EMBED_TIMEOUT_MS = 4_000;

/**
 * Await one query embedding without allowing a stalled provider to block
 * lexical discovery. The losing promise is intentionally not cancelled — the
 * Embedder type has no signal seam — but its eventual settlement is handled so
 * a late rejection cannot become an unhandled promise.
 */
async function embedWithBudget(
  embedder: Embedder,
  query: string,
  budgetMs: number,
): Promise<{ outcome: 'embedded'; vector: number[] } | { outcome: 'timeout' | 'failed' }> {
  const p = Promise.resolve().then(() => embedder(query));
  if (!(budgetMs > 0)) {
    try {
      return { outcome: 'embedded', vector: await p };
    } catch {
      return { outcome: 'failed' };
    }
  }
  return await new Promise<
    { outcome: 'embedded'; vector: number[] } | { outcome: 'timeout' | 'failed' }
  >((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { outcome: 'embedded'; vector: number[] } | { outcome: 'timeout' | 'failed' }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({ outcome: 'timeout' }), budgetMs);
    p.then(
      (vector) => finish({ outcome: 'embedded', vector }),
      () => finish({ outcome: 'failed' }),
    );
  });
}

/**
 * High-confidence symptom → decisive first-read routing. Semantic similarity is
 * excellent for recall but cannot promise the causal-chain tool outranks every
 * detail surface. These rules cover recurring incident language where the
 * platform already has one authoritative first read. An explicit `group:verb`
 * in the query always wins through the normal exact-name lexical ranking.
 */
export function decisiveToolForSymptom(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (/[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*/i.test(q)) return null;
  // The roster audit composes census, claims, waits and wake outcomes. Generic
  // "audit" name hits otherwise outrank this maintained first-read surface.
  if (/\bparked[\s-]+agents?\b/.test(q) && /\baudit\b/.test(q)) return 'coord:roster';
  if (/(?:agents?|sessions?|work)/.test(q) && /account|credential|quota|provider/.test(q)
      && /before|working|doing|recover|interrupted/.test(q)) return 'sessions:digest';
  if (/connection refused|service (?:is )?(?:down|unreachable)|process (?:is )?running but no window|app (?:will not|won't) open/.test(q)) {
    return 'dev:service_health';
  }
  if (
    /why (?:is|are).*(?:slow|stalled|stuck|queued|not shipping|not deploying)|(?:agents?|turns?|runs?).*(?:slow|queued|stalling)|capacity crunch|out of (?:quota|capacity)|rate limit|\b429\b/.test(q)
  ) {
    return 'dev:why';
  }
  // WI-6524: "is my change live yet" is the single most common liveness question
  // on this platform (CLAUDE.md names dev:pipeline_position as ITS answer) but the
  // phrasing itself semantically ranked the tool ~13th, behind unrelated detail
  // surfaces — because none of those detail tools are wrong exactly, just not the
  // one authoritative first read. Route it decisively, same as the other symptoms.
  if (
    /is (?:my|this|the) (?:change|edit|fix|code|commit|pr)\b[^?]*\b(?:live|deployed|shipped)\b|has (?:my|this|the) (?:change|edit|fix|code|commit) (?:shipped|deployed|landed|reached)|when will (?:my|this) change (?:be live|deploy)|not (?:yet )?(?:live|deployed) on (?:the )?(?:running )?server|which sha is (?:live|deployed|running)/.test(
      q,
    )
  ) {
    return 'dev:pipeline_position';
  }
  // WI-6524: the staleness-check side of the same gap — "is this value stale" is
  // exactly what a registered state cell exists to answer, but the phrasing (as
  // opposed to the surface's own vocabulary, "read a registered state cell")
  // matched nothing in the top 25.
  if (
    /(?:check|verify|confirm) (?:whether|if) .*\bis stale\b|\b(?:is|was) (?:this|that|the) value (?:i (?:was given|have|received)|stale)\b|stale (?:value|read|data) check/.test(
      q,
    )
  ) {
    return 'state:read';
  }
  return null;
}

function entryHit(e: ToolDiscoveryEntry, via: ToolFindHit['via'], cosine: number | null): ToolFindHit {
  return {
    tool: e.tool,
    description: e.description ?? null,
    argSchema: e.argSchema ?? null,
    category: e.category,
    via,
    cosine,
  };
}

/**
 * Hybrid search with explicit-name priority and blended non-exact candidates.
 */
export async function findTools(
  corpus: readonly ToolDiscoveryEntry[],
  query: string,
  opts: ToolFindOptions = {},
): Promise<ToolFindHit[]> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const minCosine = opts.minCosine ?? DEFAULT_MIN_COSINE;
  const embedTimeoutMs = opts.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;

  // 1. Lexical leg — authoritative. Over-fetch so its ranking survives the cap.
  const lexical = searchTools(corpus, query, { limit: limit * 3 });

  // 2. Semantic leg — only when an embedder + corpus index are present.
  const cosByName = new Map<string, number>();
  if (opts.embedder && opts.embeddings && opts.embeddings.size > 0 && query.trim()) {
    const embedded = await embedWithBudget(opts.embedder, query, embedTimeoutMs);
    if (embedded.outcome !== 'embedded') {
      opts.onQueryEmbeddingOutcome?.(embedded.outcome);
    } else if (!Array.isArray(embedded.vector) || embedded.vector.length === 0) {
      opts.onQueryEmbeddingOutcome?.('invalid-vector');
    } else {
      const qv = embedded.vector;
      // WIDTH GUARD (P-019). The catalog index is built ONCE at boot with
      // whatever `buildQueryEmbedder` resolved then; the query is embedded per
      // call. Those are normally the same embedder — measured 2026-08-08, both
      // are gemma@768, one space — but nothing STRUCTURALLY pins them together,
      // so a settings change that swaps embedder width leaves a stale index in a
      // different space from the live query.
      //
      // Skipping the leg outright (rather than letting every row score) is the
      // load-bearing part: this tool's contract is that it "never silently
      // pretends semantic ran", and it reports the leg as having run whenever it
      // scores anything. Scoring a mismatched index would satisfy that reporting
      // path with meaningless numbers. No cosine at all ⇒ lexical-only ⇒ the
      // result says so, which is the documented degrade.
      const indexWidth = opts.embeddings.values().next().value?.length ?? 0;
      if (qv.length !== indexWidth) {
        opts.onQueryEmbeddingOutcome?.('width-mismatch');
      } else {
        opts.onQueryEmbeddingOutcome?.('used');
        const byName = new Map(corpus.map((e) => [e.tool, e]));
        for (const [name, vec] of opts.embeddings) {
          if (!byName.has(name)) continue;
          const c = cosineSimilarity(qv, vec);
          if (c >= minCosine) cosByName.set(name, c);
        }
      }
    }
  }

  // Blend non-exact candidates before truncation: incidental keyword hits must
  // not exhaust the result cap before the semantic leg can contribute.
  const byName = new Map(corpus.map((e) => [e.tool, e]));
  const lexicalScores = new Map(lexical.map(e => [e.tool, scoreTool(e, query)]));
  const maxLexical = Math.max(1, ...lexicalScores.values());
  const candidates = new Set([...lexicalScores.keys(), ...cosByName.keys()]);
  const explicitNames = [...new Set(query.toLowerCase().match(/[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*/g) ?? [])];
  const explicitOrder = new Map(explicitNames.map((name, index) => [name, index]));
  for (const name of explicitNames) if (byName.has(name)) candidates.add(name);
  const blended = (name: string) => cosByName.size === 0
    ? (lexicalScores.get(name) ?? 0)
    : 0.45 * (lexicalScores.get(name) ?? 0) / maxLexical + 0.55 * (cosByName.get(name) ?? 0);
  const ranked = [...candidates].sort((a, b) =>
    (explicitOrder.get(a) ?? Infinity) - (explicitOrder.get(b) ?? Infinity) ||
    blended(b) - blended(a) || a.localeCompare(b));
  const out = ranked.slice(0, limit).map(name => entryHit(byName.get(name)!,
    cosByName.has(name) ? (lexicalScores.has(name) ? 'both' : 'semantic') : 'lexical',
    cosByName.get(name) ?? null));

  const decisive = decisiveToolForSymptom(query);
  const decisiveEntry = decisive ? byName.get(decisive) : undefined;
  if (decisive && decisiveEntry) {
    const existing = out.find((hit) => hit.tool === decisive);
    const routed = existing ?? entryHit(decisiveEntry, 'lexical', cosByName.get(decisive) ?? null);
    return [routed, ...out.filter((hit) => hit.tool !== decisive)].slice(0, limit);
  }
  return out.slice(0, limit);
}
