/**
 * dev:pg_health — embedded-pg health summary.
 *
 * Returns version + total/active/idle connection counts. Cheap read-only
 * query; safe for periodic polling.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { SU_LOCK_TX_POOL_LABEL } from '@papercusp/locks';
import {
  acquireSnapshot,
  acquireTicketSnapshot,
  describeStoreIdentityMismatch,
  pgResultDiagnosticSnapshot,
  storeIdentityViolation,
} from '@papercusp/db-org';
import { pgHealth } from '../../dev-data';

const ACQUISITION_POOLS = [
  'org-app',
  'org-admin',
  'org-admin-lossless-bigint',
  SU_LOCK_TX_POOL_LABEL,
] as const;

export default defineTool({
  name: 'dev:pg_health',
  profile: 'engineer',
  description:
    'PostgreSQL version + connection counts, bounded completed-query diagnostics and separate registered acquisition snapshots from this process. localOnly skips the database health query.',
  capability: 'intel:read',
  guidance: {
    when: `Diagnostic snapshot of PG health — connections, longest query, lock count, and bounded recent failures. For the /dev/pg dashboard. Use localOnly during pool contention to inspect this process's retained results, registered acquisition tickets, and raw PAPERCUSP_DB_POOL_MAX override without a health query; logical tickets do not measure physical connection occupancy, in-flight SQL or other processes.`,
    notWhen: `For application-level health, use \`harness:health\`. pg_health is the database layer.`,
    seeAlso: [
      'dev:pg_active_queries (currently-running queries)',
      'dev:pg_table_sizes (storage sizes)',
      'harness:health (application-level health)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    localOnly: z.boolean().optional().describe('Return only process-local diagnostics; skip the database health query.'),
    resultLimitPerPool: z.number().int().min(1).max(32).optional().describe(
      'Completed records per pool (default 4, maximum 32, the existing ring capacity). '
      + 'Use a wider window for transaction diagnostics; evicted records remain unavailable.',
    ),
  }),
  async handler(args) {
    const resultLimitPerPool = args.resultLimitPerPool ?? 4;
    const processDiagnostics = {
      source: 'current-process' as const,
      pid: process.pid,
      capturedAt: new Date().toISOString(),
      coverage: 'completed-results-and-recent-failures-in-selected-pools-only' as const,
      timing: 'query-build-to-terminal-not-acquisition' as const,
      preBuildTiming: 'first-query-handle-to-build-excludes-lazy-time' as const,
      queryIdentity: ['source.processInstanceId', 'source.poolInstanceId', 'connectionId', 'queryId'],
      resultLimitPerPool,
      limitations:
        'Only completed results in the named pools of this process are observed; in-flight queries, ' +
        'other pools and processes are not covered. The result ring is bounded to 32 per pool; the failure ring is ' +
        'bounded to 16, selected from that suffix according to resultLimitPerPool. An empty ring does not prove an idle database or connectivity. ' +
        'dropped counts result-ring eviction; droppedFailures counts failure-ring eviction. A separate ring retains ' +
        'up to 16 recent failed results per pool independently of successful-query volume; failures can appear in both ' +
        'rings. Neither ring retains SQL text, parameters, rows, or server messages. omittedRetained counts retained ' +
        'results outside this response window. correlationState=unobserved means no captured attempt, ' +
        'unknown means its context could not be read safely; neither means no business work occurred. ' +
        'Correlation records query creation, not current attempt liveness. elapsedMs spans build to terminal ' +
        'ReadyForQuery, not acquisition, CPU, GC or root cause. preBuildMs spans first Query.handle to build, ' +
        'including queue/connect/preparation but excluding caller-controlled lazy time; it is not pure acquisition ' +
        'or CPU, and null means unmeasured. Non-ReadyForQuery failures are not covered.',
      pools: ['org-app', 'org-admin', 'org-admin-lossless-bigint'].map((pool) => {
        const snapshot = pgResultDiagnosticSnapshot(pool, resultLimitPerPool);
        const retained = snapshot.totalRecorded - snapshot.dropped;
        return {
          ...snapshot,
          observed: snapshot.totalRecorded > 0,
          retained,
          omittedRetained: retained - snapshot.results.length,
        };
      }),
    };
    const result = {
      ...(args.localOnly ? {} : await pgHealth()),
      processDiagnostics,
      acquisitionDiagnostics: {
        source: 'current-process' as const,
        pid: process.pid,
        capturedAt: new Date().toISOString(),
        coverage: 'registered-acquisition-tickets-in-selected-pools-only' as const,
        limitations: 'Logical acquisition tickets, not physical connection occupancy. Unregistered clients and other processes are not covered; an empty snapshot does not prove health. Active tickets are bounded and sanitized by the existing registry.',
        poolConfiguration: {
          PAPERCUSP_DB_POOL_MAX: process.env.PAPERCUSP_DB_POOL_MAX ?? null,
          note: 'Raw per-process environment override only; null means unset and does not report the profile-derived effective pool max.',
        },
        pools: ACQUISITION_POOLS.map((pool) => ({
          counters: acquireSnapshot(pool),
          tickets: acquireTicketSnapshot(pool),
        })),
      },
    };
    // DELIVERY, not detection (plan outage-must-not-be-silent-2026-08-02, D-004).
    //
    // The store-identity guard already DETECTS a wrong-store read — it just reports it via
    // console.error into the operator's journal, which an agent debugging through MCP tools
    // never sees. That is the whole bug class D-004 names: on 2026-08-02 six separate guards
    // were active and the outage still presented as silence, because every one of them wrote
    // its verdict somewhere nobody reads at diagnosis time.
    //
    // dev:pg_health is where an agent looks when the database is behaving strangely, so the
    // verdict is attached HERE. `storeIdentityViolation()` is non-null only after two
    // successfully-read, genuinely different cluster identities — never on a failed probe —
    // so this cannot fire spuriously. When it is null the field is omitted entirely rather
    // than reported as a reassuring "false": an absent check and a passed check must not look
    // alike, and a guard that has never run has not cleared anything.
    const violation = storeIdentityViolation();
    if (!violation) return { data: result };
    return {
      data: {
        ...result,
        storeIdentityViolation: {
          severity: 'critical' as const,
          headline:
            'WRONG STORE — this process has talked to a different database than the one it pinned.',
          pinned: violation.pinned,
          observed: violation.observed,
          whatThisMeans:
            "Any 'not found' or empty result observed since this point is NOT evidence of data loss — " +
            'it is a correct answer from the wrong database. Do not delete, re-create or restore anything ' +
            'on the strength of it. Check ~/.papercusp/embedded-pg.json for a rewrite by another local ' +
            'install or an ephemeral operator instance.',
          detail: describeStoreIdentityMismatch(violation.pinned, violation.observed),
        },
      },
    };
  },
});
