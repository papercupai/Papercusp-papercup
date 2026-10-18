/**
 * The argument-sensitive events:status boundary, shared by its handler and
 * rubric authoring. A tool-level judge allowlist cannot express this restriction.
 * Keep this pure: authoring must check access without executing an evidence read.
 */
export function eventStatusReadAccessError(
  args: Readonly<Record<string, unknown>>,
  role: string | undefined,
): string | null {
  return role === 'judge' && (args.event != null || args.meter === true)
    ? 'events:status — the evidence-only judge may inspect its own awaits only; exact-key inspection and fleet-meter access are unavailable.'
    : null;
}
