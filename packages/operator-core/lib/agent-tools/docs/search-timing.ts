const DOCS_LEXICAL_TIMING_PHASES = ['listPages', 'getContent', 'ranking'] as const;

/** Query-free summary of the docs-engine's internal lexical phase metadata. */
export function summarizeDocsLexicalTiming(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const timing = value as Record<string, unknown>;
  const completed = timing.completedMs && typeof timing.completedMs === 'object' && !Array.isArray(timing.completedMs)
    ? timing.completedMs as Record<string, unknown>
    : {};
  const phases = DOCS_LEXICAL_TIMING_PHASES.flatMap((phase) => {
    const duration = completed[phase];
    return typeof duration === 'number' && Number.isFinite(duration)
      ? [`${phase}=${Math.max(0, Math.round(duration))}ms`]
      : [];
  });
  const active = timing.active && typeof timing.active === 'object' && !Array.isArray(timing.active)
    ? timing.active as Record<string, unknown>
    : {};
  const activePhase = active.phase;
  const activeElapsedMs = active.elapsedMs;
  const pages = timing.pages && typeof timing.pages === 'object' && !Array.isArray(timing.pages)
    ? timing.pages as Record<string, unknown>
    : {};
  const pageCounts = ['listed', 'searchable', 'loaded'].flatMap((key) => {
    const count = pages[key];
    return typeof count === 'number' && Number.isFinite(count) ? [Math.max(0, Math.trunc(count))] : [];
  });
  const fields: string[] = [];
  if (typeof timing.totalElapsedMs === 'number' && Number.isFinite(timing.totalElapsedMs)) {
    fields.push(`total=${Math.max(0, Math.round(timing.totalElapsedMs))}ms`);
  }
  if (
    timing.outcome === 'running' ||
    timing.outcome === 'complete' ||
    timing.outcome === 'cancelled' ||
    timing.outcome === 'failed'
  ) {
    fields.push(`outcome=${timing.outcome}`);
  }
  if (phases.length > 0) fields.push(`phases=${phases.join(',')}`);
  if (
    typeof activePhase === 'string' &&
    DOCS_LEXICAL_TIMING_PHASES.includes(activePhase as typeof DOCS_LEXICAL_TIMING_PHASES[number]) &&
    typeof activeElapsedMs === 'number' && Number.isFinite(activeElapsedMs)
  ) {
    fields.push(`active=${activePhase}:${Math.max(0, Math.round(activeElapsedMs))}ms`);
  }
  if (pageCounts.length === 3) fields.push(`pages=${pageCounts.join('/')}`);
  return fields.length > 0 ? `docsLexicalTiming ${fields.join(' ')}` : undefined;
}
