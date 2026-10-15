/**
 * GN-BENCH-PROVENANCE operational probe — P-005 four-arm code-intelligence engine comparison.
 *
 * Reads ONLY the committed run artifacts in docs/evidence/gitnexus-engine-comparison-2026-10-01/
 * (the output of the real `engine-comparison-cli.ts --arm … / --aggregate` run, 2026-10-01) and
 * asserts the spec falsifier is NOT present on that real data:
 *   "An unexecuted arm is reported as passed, or a task/source/cache/configuration mismatch
 *    supports a winner or savings conclusion."
 * It then writes docs/evidence/gitnexus-engine-comparison-2026-10-01-operational.json
 * (schemaVersion 1, kind operational-test-evidence) for `testing:record-run`.
 *
 * Run (repo root):  npx tsx docs/evidence/gitnexus-engine-comparison-2026-10-01-operational-probe.mts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArmReport, EngineRunMeta } from '../../packages/operator-core/lib/code-intelligence/engine-comparison';
import { ARM_ORDER, orderReports, renderEvidence } from '../../packages/operator-core/lib/code-intelligence/engine-comparison-report';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(here, 'gitnexus-engine-comparison-2026-10-01');
const OUT = resolve(here, 'gitnexus-engine-comparison-2026-10-01-operational.json');
const read = <T,>(name: string): T => JSON.parse(readFileSync(resolve(DIR, name), 'utf8')) as T;

interface Assertion { id: string; passed: boolean; evidence: string }
const assertions: Assertion[] = [];
const check = (id: string, passed: boolean, evidence: string): void => {
  assertions.push({ id, passed, evidence: evidence.slice(0, 1900) });
};

const startedAt = new Date().toISOString();

const rawReports = ARM_ORDER.map((id) => read<ArmReport>(`report-${id}.json`));
const reports = orderReports(rawReports);
const verdict = read<{
  decision: string; reasons: string[]; residue: string[];
  sourceParity: { same: boolean; fingerprints: Record<string, string | null> };
}>('verdict.json');
const taskRuns = read<Array<{ arm: string; taskId: string; rolloutId: string; runId: string; preregHash: string; graderVersion: string; harnessVersion: string }>>('task-runs.json');
const fairness = read<{ allClear: boolean; unionTasks: number; arms: string[] }>('fairness-audit.json');
const markdown = readFileSync(resolve(DIR, 'engine-comparison.md'), 'utf8');

// A1 — executed arms are separated from unavailable ones, explicitly, per arm.
const state = reports.map((r) => `${r.armId}=${r.unavailable ? `UNAVAILABLE(${r.unavailable})` : `executed(${r.cases.length} cases,${r.fixtures.length} fixtures)`}`);
check('every-arm-has-an-explicit-executed-or-unavailable-state',
  reports.length === ARM_ORDER.length
    && reports.every((r) => (r.unavailable ? r.cases.length === 0 && markdown.includes(`UNAVAILABLE: ${r.unavailable}`) : r.cases.length > 0)),
  `arms=${ARM_ORDER.join(',')}; ${state.join('; ')}`);
check('all-four-required-arms-executed-none-reported-passed-without-running',
  reports.every((r) => !r.unavailable && r.cases.length === 5 && r.fixtures.length === 3),
  `each arm carries 5 corpus cases + 3 fixtures: ${reports.map((r) => `${r.armId}:${r.cases.length}/${r.fixtures.length}`).join(' ')}`);

// A2 — outcomes attributed to the exact task, arm, seed and grader (20 = 4 arms x 5 tasks).
const rollouts = new Set(taskRuns.map((t) => t.rolloutId));
check('task-runs-attribute-every-outcome-to-arm-task-and-grader',
  taskRuns.length === 20 && rollouts.size === 20
    && new Set(taskRuns.map((t) => t.preregHash)).size === 1 && new Set(taskRuns.map((t) => t.graderVersion)).size === 1,
  `rows=${taskRuns.length} distinct rolloutIds=${rollouts.size} preregHash=${[...new Set(taskRuns.map((t) => t.preregHash))].join(',')} grader=${[...new Set(taskRuns.map((t) => t.graderVersion))].join(',')}`);
check('fairness-audit-covers-the-same-four-arms-and-five-task-union',
  fairness.arms.length === 4 && fairness.unionTasks === 5 && ARM_ORDER.every((a) => fairness.arms.includes(a)),
  `arms=${fairness.arms.join(',')} unionTasks=${fairness.unionTasks} allClear=${fairness.allClear} (allClear=false is the DISCLOSED state: single seed, no iso-budget)`);

// A3 — source / backend pins are recorded per arm and the engine versions differ where claimed.
const pins = reports.map((r) => `${r.armId}@${r.version}:${r.treeFingerprint ?? 'null'}`);
check('every-arm-records-a-backend-version-and-source-tree-fingerprint',
  reports.every((r) => !!r.version && !!r.treeFingerprint), pins.join(' | '));
const ver = (id: string): string | undefined => reports.find((r) => r.armId === id)?.version;
check('candidate-and-installed-gitnexus-are-distinct-pinned-versions',
  ver('gitnexus-installed') === '1.6.9' && ver('gitnexus-candidate') === '1.6.12',
  `installed=${ver('gitnexus-installed')} candidate=${ver('gitnexus-candidate')}`);

// A4 — THE FALSIFIER: a source/configuration mismatch must not support a winner.
const winner = verdict.decision === 'upgrade' || verdict.decision === 'replace';
check('source-parity-mismatch-is-disclosed-and-does-not-support-a-winner',
  verdict.sourceParity.same === false && !winner
    && /identical tree fingerprint across arms: \*\*NO\*\*/.test(markdown),
  `recorded sourceParity.same=${verdict.sourceParity.same} (installed arm ran on a "+dirty" tree) decision=${verdict.decision}; markdown states "identical tree fingerprint across arms: **NO**"`);
check('recorded-verdict-is-keep-with-no-hidden-residue-and-cites-measured-reasons',
  verdict.decision === 'keep' && verdict.residue.length === 0 && verdict.reasons.length >= 2
    && verdict.reasons.every((s) => /\d/.test(s)),
  `decision=${verdict.decision} residue=${JSON.stringify(verdict.residue)} reasons=${JSON.stringify(verdict.reasons)}`);

// A5 — the verdict is reproducible from the committed measurements (not hand-edited).
const meta: EngineRunMeta = { runId: 'operational-probe', seed: 0, createdAt: '2026-10-01T00:00:00.000Z', preregHash: 'probe' };
const rederived = JSON.parse(renderEvidence(reports, meta, []).verdictJson) as typeof verdict;
check('verdict-re-derives-from-the-committed-arm-reports',
  rederived.decision === verdict.decision
    && JSON.stringify(rederived.reasons) === JSON.stringify(verdict.reasons)
    && JSON.stringify(rederived.sourceParity) === JSON.stringify(verdict.sourceParity),
  `re-derived decision=${rederived.decision} reasons-equal=${JSON.stringify(rederived.reasons) === JSON.stringify(verdict.reasons)}`);

// A6 — honesty about instrument limits: disclosures are in the shipped report, not only in chat.
check('known-instrument-limits-are-disclosed-in-the-report',
  /Index health is UNMEASURED/.test(markdown) && /\+dirty/.test(markdown) && /post-hoc/i.test(markdown),
  'report names: health probe UNMEASURED (bench CLI dispatch lacks list_repos; fairness rows for the GitNexus arms read graderStatus=error for that diagnostic, NOT a failed task), the +dirty installed tree, and post-hoc grading corrections');

const finishedAt = new Date().toISOString();
const failed = assertions.filter((a) => !a.passed);
const artifact = {
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: 'GN-BENCH-PROVENANCE operational probe: P-005 four-arm engine comparison (installed GitNexus 1.6.9 / candidate 1.6.12 / Codebase-Memory / baseline LSP+rg)',
  framework: 'operational',
  command: ['npx', 'tsx', 'docs/evidence/gitnexus-engine-comparison-2026-10-01-operational-probe.mts'],
  exitCode: failed.length === 0 ? 0 : 1,
  startedAt,
  finishedAt,
  summary: `${assertions.length - failed.length}/${assertions.length} provenance assertions hold on the real committed four-arm run (verdict ${verdict.decision}; sourceParity.same=${verdict.sourceParity.same}; 20 attributed task rows; every arm executed and pinned).`,
  assertions,
};
writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`${artifact.summary}\nwrote ${OUT}`);
for (const a of failed) console.error(`FAILED ${a.id}: ${a.evidence}`);
process.exit(artifact.exitCode);
