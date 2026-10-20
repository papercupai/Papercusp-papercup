/**
 * IO bindings for the periodic full-suite run of `main` (P-013, R-11). Every decision is in
 * `periodic-full-run.ts`; this module only binds its `PeriodicFullRunDeps` seams:
 *
 *  - promotions: `git reflog show --format=%H%x09%ct <releaseRef>` in the integration root
 *    (the release ref moves only by green-checkpoint's fast-forward, so each entry is one
 *    promotion);
 *  - the full suite and each probe: `npm run lint:as-committed -- <script> --ref=<sha>`,
 *    a clean tree at exactly that sha, run through `runReservedArgv` so the leg sits in the
 *    reserved `source-checks.slice` (P-009) and never in a load-shed lane;
 *  - excluded files: active rows of the downgrade/quarantine store (P-002/P-008);
 *  - routes: ONE deduped bug per failing file (`conditionKey periodic-full-run:<file>`);
 *  - state: `harness_shared.routines.metadata.periodic_full_run` on this routine's row.
 *
 * ASYNC spawns only (the sync-batch-delta-check-deps.ts contract): a sync spawn would wedge
 * bg-host's shared event loop for the length of a whole-suite run.
 */
import { getOrgPg } from '@papercusp/db-org';
import { createOneWorkItem } from '../agent-tools/work_items/_create-core';
import { parseFailingFilesLine } from './sync-batch-delta-check';
import { parseConfirmOutput, run, runReservedArgv, type RunResult } from './sync-batch-delta-check-deps';
import { pgTestDowngradeStore, type TestDowngradeSql } from './test-downgrade-store';
import { classifyCriticalArea } from './critical-area-registry';
import {
  fullRunPayload,
  parseMainReflog,
  probePayload,
  type FullRunState,
  type FullSuiteResult,
  type PeriodicFullRunDeps,
} from './periodic-full-run';

export const PERIODIC_FULL_RUN_ROUTINE_NAME = 'periodic-full-run';
/** One whole-suite run in a fresh clean tree. Generous: the suite is ~6,700 files. */
export const FULL_SUITE_TIMEOUT_MS = 4 * 60 * 60_000;
export const PROBE_TIMEOUT_MS = 20 * 60_000;

export interface PeriodicFullRunDepsConfig {
  installSlug: string;
  workspaceId: string;
  root: string;
  releaseRef: string;
  filedBy?: string;
  exec?: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult | null>;
}

/** A full-suite run is measured only when it reached its terminal break-set line. An absent
 *  line, an unmeasured spawn, or an ENOSPC-dominated log is inconclusive (P-016's rule), and
 *  an inconclusive run never moves the baseline. */
export function classifyFullSuiteOutput(result: RunResult | null): FullSuiteResult {
  if (!result) return { status: 'inconclusive', reason: 'spawn-unmeasured' };
  const text = `${result.stdout}\n${result.stderr}`;
  if (/\bENOSPC\b|no space left on device/i.test(text)) return { status: 'inconclusive', reason: 'environment: ENOSPC' };
  const failing = parseFailingFilesLine(text);
  if (failing === null) return { status: 'inconclusive', reason: `no terminal break-set line (exit ${result.status ?? 'null'})` };
  return { status: 'measured', failing };
}

function routeTitle(file: string, route: string, culprit: string | null): string {
  const verb = route === 'fix' ? 'fix' : route === 'eject' ? 'eject the culprit promotion for' : 'downgrade or quarantine';
  return `periodic full run: ${verb} ${file}${culprit ? ` (promotion ${culprit.slice(0, 10)})` : ''}`;
}

export function buildPeriodicFullRunDeps(cfg: PeriodicFullRunDepsConfig): PeriodicFullRunDeps {
  const exec = cfg.exec ?? run;
  const filedBy = cfg.filedBy ?? 'system:periodic-full-run';
  const git = async (args: string[]): Promise<string> => {
    const res = await exec('git', ['-C', cfg.root, ...args], { cwd: cfg.root, timeoutMs: 60_000 });
    if (!res || res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res?.stderr.slice(0, 300) ?? 'unmeasured'}`);
    return res.stdout;
  };
  return {
    now: () => Date.now(),
    async readState(): Promise<FullRunState> {
      const { sql } = getOrgPg();
      const rows = await sql`
        SELECT metadata->'periodic_full_run' AS state
          FROM harness_shared.routines
         WHERE install_slug = ${cfg.installSlug} AND name = ${PERIODIC_FULL_RUN_ROUTINE_NAME}
         LIMIT 1
      `;
      const raw = (rows[0] as { state?: unknown } | undefined)?.state;
      if (!raw || typeof raw !== 'object') return { lastFullRun: null, routes: {} };
      const s = raw as Partial<FullRunState>;
      return { lastFullRun: s.lastFullRun ?? null, routes: s.routes ?? {} };
    },
    async writeState(state: FullRunState): Promise<void> {
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{periodic_full_run}', ${JSON.stringify(state)}::text::jsonb, true),
               updated_at = now()
         WHERE install_slug = ${cfg.installSlug} AND name = ${PERIODIC_FULL_RUN_ROUTINE_NAME}
      `;
    },
    mainSha: async () => (await git(['rev-parse', cfg.releaseRef])).trim(),
    promotions: async () => parseMainReflog(await git(['reflog', 'show', '--format=%H%x09%ct', cfg.releaseRef])),
    async runFullSuite(sha: string): Promise<FullSuiteResult> {
      const p = fullRunPayload(sha);
      return classifyFullSuiteOutput(await runReservedArgv(exec, p.cmd, p.args, { cwd: cfg.root, timeoutMs: FULL_SUITE_TIMEOUT_MS }));
    },
    async runFilesAt(sha: string, files: readonly string[]): Promise<Map<string, boolean | null>> {
      const out = new Map<string, boolean | null>();
      for (const file of files) {
        const p = probePayload(sha, file);
        const res = await runReservedArgv(exec, p.cmd, p.args, { cwd: cfg.root, timeoutMs: PROBE_TIMEOUT_MS });
        out.set(file, res ? parseConfirmOutput(`${res.stdout}\n${res.stderr}`) : null);
      }
      return out;
    },
    async isExcluded(file: string): Promise<boolean> {
      const { sql } = getOrgPg();
      const store = pgTestDowngradeStore(sql as unknown as TestDowngradeSql, { workspaceId: cfg.workspaceId, harnessSlug: cfg.installSlug });
      const active = await store.listActive();
      return active.some((row) => row.testFile === file && row.revokedAt === null);
    },
    async fileRoute({ file, attribution, route }): Promise<string | null> {
      const area = classifyCriticalArea(file);
      const lines = [
        `The periodic full-suite run of \`${cfg.releaseRef}\` (P-013) found \`${file}\` failing.`,
        attribution?.kind === 'attributed'
          ? `Bisection attributes it to promotion \`${attribution.culprit}\`: it passes at the previous promotion \`${attribution.previous}\` and fails at the culprit (${attribution.probes} probes).`
          : attribution
            ? `Not attributable to a single promotion: ${attribution.reason}.`
            : 'Still failing since the previous full run.',
        `Route: **${route.route}** (${route.reason}). Response order (D-002): fix, then eject the culprit promotion's change, then downgrade with a reason, an owner and a bug.`,
        area ? `Critical area: ${area.id}. A downgrade needs the explicit acknowledgement and notifies the owner (D-006).` : '',
      ].filter(Boolean);
      const res = await createOneWorkItem(
        {
          kind: 'bug',
          severity: 'major',
          harness: cfg.installSlug,
          title: routeTitle(file, route.route, route.culprit),
          summary: lines.join('\n\n'),
          conditionKey: `periodic-full-run:${file}`,
          payload: { file, route: route.route, culprit: route.culprit, attribution, filedBy },
        },
        { ownerId: filedBy, workspaceId: cfg.workspaceId, harnessSlug: cfg.installSlug },
      );
      if (!res.ok) return null;
      const wi = res.workItem as { id?: unknown; feature_id?: unknown };
      return typeof wi.id === 'string' ? wi.id : typeof wi.feature_id === 'string' ? wi.feature_id : null;
    },
    log: (line: string) => console.log(line),
  };
}
