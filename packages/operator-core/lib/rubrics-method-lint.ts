/**
 * Authoring diagnostics for acceptance-rubric methods.
 *
 * Acceptance judges can inspect cited files and invoke MCP tools, but their role
 * does not grant native shell execution. A method that tells the judge to run a
 * shell command therefore produces an ungradeable criterion. This stays advisory:
 * the criterion may still be intentionally manual, and MCP instructions such as
 * `testing:run` are valid judge actions.
 */
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import type { WorkItem } from './work-items';

export type AcceptanceMethodLintMarker = 'npm-run' | 'proc-path' | 'pgrep' | 'backticked-shell';

export interface AcceptanceMethodLintFinding {
  code: 'acceptance-method-native-shell';
  criterionKey: string;
  markers: AcceptanceMethodLintMarker[];
  message: string;
}

export interface CriterionMethodForLint {
  key: string;
  barKey?: string;
  method?: string | null;
}

const NPM_RUN_RE = /\bnpm\s+run\b/i;
const PROC_PATH_RE = /(?:^|[\s`])\/proc(?:\/|[\s`]|$)/i;
const PGREP_RE = /\bpgrep\b/i;

// Keep this list deliberately narrow. It catches a command-shaped inline shell
// instruction without treating a backticked MCP tool name (`testing:run`,
// `plans:audit`, …) as a native command.
const BACKTICKED_SHELL_RE =
  /`\s*(?:npm|npx|pnpm|yarn|bun|node|bash|sh|zsh|cargo|git|curl|wget|ps|cat|sed|awk|grep|find|kill|systemctl|python(?:3)?|tsx)\b[^`]*`/i;

const METHOD_ADVICE =
  'Acceptance judges cannot run native shell commands. Use MCP evidence instead: testing:run/testing:runs for test outcomes, plans:audit or cited source/tests for code truth, and state:read or a recorded artifact for runtime facts. MCP tool instructions such as testing:run remain valid.';

/**
 * Return advisory findings for acceptance criteria whose method asks for a
 * native-shell action. Standard rubrics are intentionally handled by the caller
 * and are not included in this acceptance-specific lint.
 */
export function lintAcceptanceCriterionMethods(
  criteria: readonly CriterionMethodForLint[],
): AcceptanceMethodLintFinding[] {
  const findings: AcceptanceMethodLintFinding[] = [];
  for (const criterion of criteria) {
    const method = criterion.method?.trim();
    if (!method) continue;

    const markers: AcceptanceMethodLintMarker[] = [];
    if (NPM_RUN_RE.test(method)) markers.push('npm-run');
    if (PROC_PATH_RE.test(method)) markers.push('proc-path');
    if (PGREP_RE.test(method)) markers.push('pgrep');
    if (BACKTICKED_SHELL_RE.test(method)) markers.push('backticked-shell');
    if (markers.length === 0) continue;

    findings.push({
      code: 'acceptance-method-native-shell',
      criterionKey: criterion.key,
      markers,
      message: `${METHOD_ADVICE} Rewrite the method as a readable evidence procedure, or leave it explicitly manual; this is an authoring advisory, not a rejection.`,
    });
  }
  return findings;
}

export interface AcceptanceDependencyLintFinding {
  code: 'acceptance-method-dependency-coverage' | 'acceptance-method-dependency-unverified';
  criterionKey: string;
  dependencyId: string;
  message: string;
}

type DependencySnapshot = Pick<WorkItem, 'id' | 'state' | 'terminalCompletionEvidence'>;
type ReadDependencies = (ids: string[], harness?: string) => Promise<DependencySnapshot[]>;

/** Only explicit implementation dependencies are claims of outstanding work.
 * Historical evidence citations and ordinary work-item mentions are not.
 */
function implementationDependencyIds(method: string): string[] {
  const clauses = method.matchAll(
    /\bimplementation dependenc(?:y|ies)\s*(?:is|are|:)\s*((?:(?:WI|EI)-\d+)(?:\s*(?:,|and|or)\s*(?:WI|EI)-\d+)*)/gi,
  );
  return [...new Set([...clauses].flatMap((match) => match[1]!.match(/(?:WI|EI)-\d+/gi) ?? []))]
    .map((id) => id.toUpperCase());
}

function coverageNamesCriterion(entry: string, criterion: CriterionMethodForLint): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/-/g, '');
  const identities = new Set([criterion.key, criterion.barKey].filter((value): value is string => !!value).map(normalize));
  return (entry.match(/[a-z0-9]+(?:-[a-z0-9]+)*/gi) ?? [])
    .some((token) => identities.has(normalize(token)));
}

/** Extend the existing authoring advisory with current dependency evidence.
 * A terminal lifecycle alone cannot discharge a different BAR. Do not infer
 * coverage from a title/summary or treat a failed read as absence.
 */
export async function lintAcceptanceMethods(
  criteria: readonly CriterionMethodForLint[],
  harness?: string,
  readDependencies: ReadDependencies = async (ids, scope) => {
    const { getWorkItemsByIds } = await import('./work-items');
    return getWorkItemsByIds(ids, scope, { includeBody: false, payloadProjection: 'completionEvidence' });
  },
): Promise<Array<AcceptanceMethodLintFinding | AcceptanceDependencyLintFinding>> {
  const findings: Array<AcceptanceMethodLintFinding | AcceptanceDependencyLintFinding> = lintAcceptanceCriterionMethods(criteria);
  const references = criteria.flatMap((criterion) =>
    implementationDependencyIds(criterion.method ?? '').map((dependencyId) => ({ criterion, dependencyId })),
  );
  if (!references.length) return findings;

  let dependencies: DependencySnapshot[];
  try {
    dependencies = await readDependencies([...new Set(references.map((ref) => ref.dependencyId))], harness);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [...findings, ...references.map(({ criterion, dependencyId }): AcceptanceDependencyLintFinding => ({
      code: 'acceptance-method-dependency-unverified', criterionKey: criterion.key, dependencyId,
      message: `Implementation dependency could not be verified: ${detail}. Keep its coverage unknown and retry the authoritative work-item read.`,
    }))];
  }

  const byId = new Map(dependencies.map((item) => [item.id, item]));
  for (const { criterion, dependencyId } of references) {
    const dependency = byId.get(dependencyId);
    if (!dependency) {
      findings.push({
        code: 'acceptance-method-dependency-unverified', criterionKey: criterion.key, dependencyId,
        message: 'Implementation dependency did not resolve in this scope. Verify its identity; this is not proof that the work is missing or complete.',
      });
      continue;
    }
    if (!ANY_FAMILY_TERMINAL_STATES.includes(dependency.state)) continue;
    const checked = dependency.terminalCompletionEvidence?.coverage?.checked ?? [];
    if (checked.some((entry) => coverageNamesCriterion(entry, criterion))) continue;
    findings.push({
      code: 'acceptance-method-dependency-coverage', criterionKey: criterion.key, dependencyId,
      message: `Implementation dependency ${dependencyId} is terminal (${dependency.state}), but its checked completion coverage does not name ${criterion.barKey ?? criterion.key}. Terminal state and unrelated test results do not establish this criterion's detector coverage. Reference an owned unfinished implementation item, or cite explicit matching completion coverage; preserve the qualification gap until verified.`,
    });
  }
  return findings;
}

