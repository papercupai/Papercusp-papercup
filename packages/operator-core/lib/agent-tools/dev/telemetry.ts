/**
 * dev:telemetry — cross-workspace tool-invocation rollup.
 *
 * Returns per-tool call counts, error counts, p50/p95 duration, and the
 * set of workspaces that invoked each tool — over the last N hours.
 * Drives the /dev page Telemetry tab.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { trackPhase } from '@papercusp/tooldef';
import { flagPollSuspects, handlerPhaseRollup, telemetryRollup } from '../../dev-data';
import { readRuntimeSecurityCensus, runtimeObservabilityHealth } from '../../observability/runtime';
import { resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'dev:telemetry',
  profile: 'engineer',
  description: 'Per-tool invocation rollup (count, error rate, p50/p95) across selected workspaces over the last N hours.',
  capability: 'intel:read',
  effect: 'read',
  effectForCall: args => args.capture === true ? 'write' : 'read',
  guidance: {
    when: `Read recent telemetry datapoints (errors, slow requests). For the /dev/telemetry dashboard.`,
    notWhen: `For per-agent audit, use \`audit:list\`. telemetry is observability-shaped, not action-shaped.`,
    seeAlso: [
      'dev:tool_cooccurrence (which tools co-occur in a spawn)',
      'dev:code_run_adoption (code:run adoption metrics)',
      'audit:list (per-agent audit trail)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    view: z.enum(['rollup', 'security-census']).optional()
      .describe('security-census reads the actual serving host and boot artifact: incomplete discovery, never a security verdict. Default rollup.'),
    capture: z.boolean().optional()
      .describe('security-census only: persist the full host snapshot and signed authenticated producer receipt in immutable artifacts. No qualification or closure approval.'),
    harness: z.string().min(1).max(120).optional().describe('Concrete harness for authenticated security-census capture; defaults to the transport scope.'),
    workspaceIds: z.array(z.string()).nullable().optional(),
    /** Filter by which transport drove the dispatch. 'unknown' matches
     *  rows pre-migration 058 (transport=NULL). null/omitted = no filter. */
    transports: z.array(z.enum(['http', 'mcp', 'ipc', 'in_process', 'unknown']))
      .nullable().optional(),
    hours: z.number().int().positive().max(168).optional(),
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
      .describe('security-census only: zero-based offset into the sorted full population.'),
    discoverySha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
      .describe('security-census only: full population digest returned by the first page; refuses a changed population.'),
    phasesFor: z.string().min(1).optional()
      .describe('Tool name: also return its per-phase timing (handlerPhases) and phase coverage of wall time.'),
  }),
  async handler(args, ctx) {
    if (args.capture === true) {
      if (args.view !== 'security-census' || args.limit !== undefined || args.offset !== undefined || args.discoverySha256 !== undefined) {
        throw Error('security_census_capture_requires_full_snapshot');
      }
      const harness = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harness) throw Error('security_census_capture_requires_concrete_harness');
      const { captureAuthenticatedRuntimeSecurityCensus } = await import('../../coverage-census/security-qualification');
      return { content: [{ type: 'text', text: JSON.stringify(await trackPhase(ctx.phases,
        'dev:telemetry:security-census-capture', () => captureAuthenticatedRuntimeSecurityCensus(ctx, harness))) }] };
    }
    if (args.view === 'security-census') {
      return { content: [{ type: 'text', text: JSON.stringify(await trackPhase(ctx.phases,
        'dev:telemetry:security-census', () => readRuntimeSecurityCensus(args.limit, {
          offset: args.offset, expectedDiscoverySha256: args.discoverySha256,
        }))) }] };
    }
    const hours = args.hours ?? 24;
    const [result, handlerPhases] = await Promise.all([
      trackPhase(
        ctx.phases,
        'dev:telemetry:rollup',
        () => telemetryRollup({
          workspaceIds: args.workspaceIds ?? null,
          transports: args.transports ?? null,
          hours,
          limit: args.limit,
        }),
      ),
      args.phasesFor
        ? trackPhase(
            ctx.phases,
            'dev:telemetry:handler-phase-rollup',
            () => handlerPhaseRollup({ toolName: args.phasesFor!, workspaceIds: args.workspaceIds ?? null, hours }),
          )
        : Promise.resolve(null),
    ]);
    // Poll-detector guard (EI-7029): surface polling-shaped tools UP FRONT so a
    // new storm is flagged on the next telemetry read, not discovered from a
    // bandwidth bill. Empty array = nothing suspect.
    const pollSuspects = flagPollSuspects(result.entries, hours);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: result.entries.length,
            poll_suspects: pollSuspects,
            observability: runtimeObservabilityHealth(),
            ...(handlerPhases ? { handler_phases: handlerPhases } : {}),
            entries: result.entries,
          }),
        },
      ],
    };
  },
});
