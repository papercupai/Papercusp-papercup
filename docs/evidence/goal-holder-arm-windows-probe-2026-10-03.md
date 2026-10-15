# Goal-holder arm-window probe (plan goal-holder-plans-ideation-truthful-reports-2026-10-03, P-011 / D-007)

Read-only probe that scored the already-run arm windows of goal 60d3a8 with `packages/operator-core/lib/goal-holder-behavior-metrics.ts` on 2026-10-03 (build ac5e5daf51). Outputs: `docs/evidence/goal-holder-arm-windows-2026-10-03.json` (first run, ~03:53Z) and `docs/evidence/goal-holder-arm-windows-rev-2026-10-03.json` (re-measure after the metric fix, ~04:42Z). Original location: `.papercusp/scratch/p011/arms.mts` (run with `npx tsx`; the relative imports assume that location).

```ts
// P-011 (goal-holder-plans-ideation-truthful-reports-2026-10-03, D-007): score the already-run
// R-4 arm windows on goal 60d3a8 with the P-001 metrics module. Read-only.
// Windows are taken as goal-agent-behavior-feedback-2026-09-06 bound them (D-044..D-063,
// WI-10003890 checkpoint, peer su-cf569f3f). Holders come from tool_invocations
// goal_actor_class='holder-agent' telemetry inside each window (agent_modes keeps no history).
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../../../packages/operator-core/lib/embedded-pg-discovery.ts';
import {
  collectGoalHolderBehaviorMetrics,
  rateGoalHolderBehavior,
} from '../../../packages/operator-core/lib/goal-holder-behavior-metrics.ts';

const WS = 'papercusp-workspace';
const GOAL = 'work-on-everything-fresh-grading-and-improvement-60d3a8';
const ARMS = [
  { arm: 'full-p1', start: '2026-09-30T17:59:33Z', end: '2026-09-30T20:54:34Z', d046: 'placed after 10', src: 'WI-10003890 18:30Z; D-047' },
  { arm: 'brief-only', start: '2026-09-30T23:59:54.717Z', end: '2026-10-01T03:13:18Z', d046: 'placed after 7', src: 'D-046/D-047' },
  { arm: 'full-p2', start: '2026-10-01T04:01:10.607Z', end: '2026-10-01T11:01:44.771Z', d046: 'censored 0', src: 'D-048/D-053' },
  { arm: 'full-p3', start: '2026-10-01T12:09:51.307Z', end: '2026-10-01T15:14:29.298Z', d046: 'placed after 3', src: 'D-054/D-056' },
  { arm: 'baseline', start: '2026-10-02T02:28:59.745Z', end: '2026-10-02T12:10:00Z', d046: 'censored 4', src: 'D-060/D-061' },
  { arm: 'full-w4', start: '2026-10-02T12:31:30.496Z', end: '2026-10-02T14:11:54.426Z', d046: 'placed after 1', src: 'D-063' },
];

const sql = postgres(getHarnessAdminUrl(), { max: 4, idle_timeout: 5 });
const out: unknown[] = [];
try {
  for (const a of ARMS) {
    const holders = await sql<{ owner: string; n: string; first: Date; last: Date }[]>`
      SELECT coord_owner_id AS owner, count(*)::text AS n, min(invoked_at) AS first, max(invoked_at) AS last
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${WS} AND goal_id = ${GOAL} AND goal_actor_class = 'holder-agent'
         AND invoked_at BETWEEN ${new Date(a.start)} AND ${new Date(a.end)}
       GROUP BY 1 ORDER BY min(invoked_at)`;
    for (const h of holders) {
      // One holder: the whole arm window. Several: each holder's active span inside it.
      const ws = holders.length === 1 ? a.start : new Date(Math.max(+new Date(a.start), +h.first)).toISOString();
      const we = holders.length === 1 ? a.end : new Date(Math.min(+new Date(a.end), +h.last)).toISOString();
      const m = await collectGoalHolderBehaviorMetrics(
        { workspaceId: WS, goalId: GOAL, holderOwnerId: h.owner, windowStart: ws, windowEnd: we },
        { sql },
      );
      const r = rateGoalHolderBehavior(m);
      out.push({
        arm: a.arm, d046: a.d046, holder: h.owner.slice(0, 11), holderCalls: Number(h.n),
        span: holders.length === 1 ? 'arm' : 'holder-span', ws, we,
        plans: m.planAuthorship, ideation: { ...m.ideation, since: undefined }, reports: m.ownerReports,
        loop: m.loop, nudges: m.nudges,
        verdicts: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.verdict])),
      });
    }
    if (holders.length === 0) out.push({ arm: a.arm, d046: a.d046, holder: null, note: 'no holder-agent telemetry in window' });
  }
} finally {
  await sql.end({ timeout: 5 });
}
console.log(JSON.stringify(out));
```
