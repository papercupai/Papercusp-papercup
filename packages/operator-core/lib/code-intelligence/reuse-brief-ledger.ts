/** Issued contributions share the existing push ledger; unknown reads are never pushes. */
import type { ReuseProviderContext, ReuseProviderObservation } from './reuse-brief-providers';
import { reuseHoldout } from './reuse-measurement';

export interface ReuseIssuedRecord {
  context: ReuseProviderContext;
  observations: readonly ReuseProviderObservation[];
  /** The recovery call the recipient received; absent when it was withheld (P-006). */
  recover?: { tool: string; args: unknown };
}

/** Keep the complete identity, including dispatch and source/index versions, independently per source. */
export function reuseIssuedSubjects(input: ReuseIssuedRecord) {
  return input.observations.filter(row => row.status === 'issued' && row.chars > 0
    && row.sourceVersion && row.indexVersion).map(row => ({ row, subject: JSON.stringify({
    schema: 'reuse-brief-v1', provider: row.provider, surface: input.context.surface,
    invocation: input.context.invocation, workItem: input.context.workItem ?? null,
    harness: input.context.repository?.harness ?? null,
    plan: input.context.plan ?? null, planItems: input.context.planItems ?? [],
    sourceVersion: row.sourceVersion, indexVersion: row.indexVersion, outcome: row.reason,
    ...(row.cohort ? { cohort: row.cohort, selector: { paths: row.citedPaths, symbols: [] } } : {}),
  }) }));
}

export async function recordReuseBriefIssued(input: ReuseIssuedRecord, signal: AbortSignal): Promise<boolean> {
  const held = input.observations.filter(row => row.status === 'held-out' && row.reason === 'holdout'
    && row.cohort === 'holdout' && row.chars === 0 && row.sourceVersion && row.indexVersion
    && input.context.workItem && reuseHoldout(input.context.workItem, row.provider));
  const subjects = [...reuseIssuedSubjects(input), ...held.map(row => ({ row, subject: JSON.stringify({
    schema: 'reuse-brief-v1', provider: row.provider, surface: input.context.surface,
    invocation: input.context.invocation, workItem: input.context.workItem,
    harness: input.context.repository?.harness ?? null,
    plan: input.context.plan ?? null, planItems: input.context.planItems ?? [],
    sourceVersion: row.sourceVersion, indexVersion: row.indexVersion, outcome: 'holdout',
    cohort: 'holdout', selector: { paths: row.citedPaths, symbols: [] },
  }) }))];
  if (!subjects.length) return true;
  if (!input.context.workspaceId || !input.context.owner || !input.context.invocation || signal.aborted) return false;
  const { withWorkspace } = await import('@papercusp/db-org');
  return withWorkspace(input.context.workspaceId, async tx => {
    await tx`SELECT set_config('lock_timeout', '50ms', true), set_config('statement_timeout', '100ms', true)`;
    const turns = await tx<{ turn_id: string }[]>`SELECT turn_id FROM harness_shared.identity_hook_turns
      WHERE workspace_id = ${input.context.workspaceId} AND owner_id = ${input.context.owner}`;
    // Do not mint a turn just to make telemetry look measured.
    if (!turns[0]?.turn_id) return false;
    const epochs = await tx<{ epoch: number }[]>`SELECT epoch FROM harness_shared.memory_session_epochs
      WHERE session_id = ${input.context.owner}`;
    for (const { row, subject } of subjects) {
      if (signal.aborted) throw new Error('Reuse brief ledger deadline');
      await tx`INSERT INTO harness_shared.code_intel_pushes
        (workspace_id, owner_id, epoch, turn_id, leg, subject, snapshot_commit, cited_paths, suggested_call, chars)
        VALUES (${input.context.workspaceId}, ${input.context.owner}, ${Number(epochs[0]?.epoch ?? 0)},
          ${turns[0].turn_id}, ${row.status === 'held-out' ? `reuse-holdout-${row.provider}` : `reuse-${row.provider}`}, ${subject}, ${input.context.commit ?? null},
          ${row.citedPaths}::text[], ${input.recover ? `${input.recover.tool} ${JSON.stringify(input.recover.args)}` : null}, ${row.chars})
        ON CONFLICT (workspace_id, owner_id, epoch, leg, subject) DO NOTHING`;
    }
    if (signal.aborted) throw new Error('Reuse brief ledger deadline');
    return true;
  });
}
