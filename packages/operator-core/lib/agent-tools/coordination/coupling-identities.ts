/** Resolve both sides of a coupling against the live owner roster before writing. */
import { resolveExplicitAgentOwnerId, type ExplicitAgentOwnerResolution } from './recipient-resolve';

export type CouplingIdentityPairResult =
  | { ok: true; a: string; b: string }
  | {
      ok: false;
      error: 'unknown_recipient';
      detail: string;
      unknown_recipients?: string[];
      ambiguous_recipients?: { id: string; matches: string[] }[];
      invalid_recipients?: { id: string; reason: string }[];
    };

/**
 * Persistent coupling writes must use full, known owner IDs. Reuse the same
 * roster resolver as coord:send, with its strict fail-closed mode, so short
 * prefixes resolve and unknown or ambiguous IDs cannot become dead edges.
 */
export async function resolveCouplingIdentityPair(
  rawA: string | undefined,
  rawB: string,
  callerOwnerId: string,
  workspaceId?: string | null,
): Promise<CouplingIdentityPairResult> {
  const [a, b]: [ExplicitAgentOwnerResolution, ExplicitAgentOwnerResolution] = await Promise.all([
    rawA === undefined
      ? Promise.resolve<ExplicitAgentOwnerResolution>({ ok: true, ownerId: callerOwnerId })
      : resolveExplicitAgentOwnerId(rawA, callerOwnerId, workspaceId),
    resolveExplicitAgentOwnerId(rawB, callerOwnerId, workspaceId),
  ]);

  const failures: { input: string; result: ExplicitAgentOwnerResolution }[] = [];
  if (!a.ok) failures.push({ input: rawA ?? callerOwnerId, result: a });
  if (!b.ok) failures.push({ input: rawB, result: b });
  if (failures.length === 0 && a.ok && b.ok) return { ok: true, a: a.ownerId, b: b.ownerId };

  const unknownRecipients: string[] = [];
  const ambiguousRecipients: { id: string; matches: string[] }[] = [];
  const invalidRecipients: { id: string; reason: string }[] = [];
  const details: string[] = [];
  for (const { input, result } of failures) {
    if (result.ok) continue;
    details.push(result.message);
    if (result.code === 'assignee_unknown') unknownRecipients.push(input.trim());
    else if (result.code === 'assignee_ambiguous') {
      ambiguousRecipients.push({ id: input.trim(), matches: result.candidates ?? [] });
    } else invalidRecipients.push({ id: input.trim(), reason: result.message });
  }

  return {
    ok: false,
    error: 'unknown_recipient',
    detail: details.join(' '),
    ...(unknownRecipients.length ? { unknown_recipients: unknownRecipients } : {}),
    ...(ambiguousRecipients.length ? { ambiguous_recipients: ambiguousRecipients } : {}),
    ...(invalidRecipients.length ? { invalid_recipients: invalidRecipients } : {}),
  };
}
