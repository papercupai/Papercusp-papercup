/**
 * Critical-area registry — plan green-main-ratchet-convergence-2026-10-17, P-003 (R-2, D-006).
 *
 * A test downgrade (P-002) makes a failing test non-blocking for main. In a critical area
 * that can ship broken behaviour where it costs most, so D-006 lets the downgrade through
 * only with an explicit acknowledgement naming the area and the risk, and notifies the
 * owner at once instead of only in the daily digest.
 *
 * The area is DERIVED from the test's repo-relative path (or a gate leg id such as
 * `lint:tsc:operator`). Nothing is declared per test, so a new test in a critical
 * directory is covered without anyone remembering to register it.
 *
 * Distinct from `apps/operator/lib/release/risk-tier.ts`: that one decides whether a
 * DEPLOY may go out unattended (everything that is not docs/tests is `review`). This one
 * names the seven areas the owner listed, and must not mark ordinary product code as
 * critical (R-2 falsifier 3), so it is deliberately narrow.
 */

export type CriticalAreaId =
  | 'gate'
  | 'migrations-schema'
  | 'auth-secrets'
  | 'data-integrity'
  | 'typecheck-build'
  | 'agent-control-plane'
  | 'deploy-release';

export interface CriticalArea {
  id: CriticalAreaId;
  label: string;
  /** What a broken test here can let through — quoted in the forceful warning. */
  risk: string;
}

interface AreaRule extends CriticalArea {
  patterns: readonly RegExp[];
}

// A path segment boundary: start, `/`, `.`, `_` or `-` on both sides of a word.
const seg = (words: string) => new RegExp(`(^|[/._-])(${words})([/._-]|$)`, 'i');

/**
 * Ordered: the first matching area wins, so the more specific `gate` rule runs before the
 * broader `deploy-release` rule that would otherwise claim every file under lib/release.
 */
const RULES: readonly AreaRule[] = [
  {
    id: 'gate',
    label: 'the gate itself',
    risk: 'the green-checkpoint gate could promote a red candidate, or hold main on a green one',
    patterns: [
      /green-checkpoint/,
      /frozen-candidate-repair-queue/,
      /frozen-repair-/,
      /admission-ratchet/,
      /round-one-measurement/,
      /test-downgrade/,
      /critical-area-registry/,
      /(^|\/)scripts\/(affected-tests|test-files|lint-tsc)[^/]*$/,
    ],
  },
  {
    id: 'migrations-schema',
    label: 'migrations/schema',
    risk: 'a schema migration could apply broken or destructive DDL to the live database',
    patterns: [/(^|\/)libs\/papercusp\/libs\/db\//, /\.sql$/, seg('migrations?|schema'), /next-migration/],
  },
  {
    id: 'auth-secrets',
    label: 'auth/permissions/secrets',
    risk: 'access control or secret handling could be bypassed or leak credentials',
    patterns: [seg('auth|oauth|permissions?|secrets?|credentials?|rbac|rls|tokens?')],
  },
  {
    id: 'data-integrity',
    label: 'data integrity',
    risk: 'stored data could be lost, corrupted or restored incorrectly',
    patterns: [seg('backup|restore|integrity|data-loss|pitr|wal')],
  },
  {
    id: 'typecheck-build',
    label: 'typecheck/build of shipped code',
    risk: 'code that does not typecheck or build could ship to the running fleet',
    patterns: [/^(lint:tsc|typecheck|build)(:|$)/, /(^|\/)scripts\/(build|typecheck)[^/]*$/],
  },
  {
    id: 'agent-control-plane',
    label: 'the agent control plane',
    risk: 'coordination, locks, work-item claims or agent launch could misroute or drop agent work',
    patterns: [
      /(^|\/)agent-tools\/(coordination|locks|loop|modes?|work-items|scheduler|fleet)\//,
      /(^|\/)orchestrator\/src\//,
      seg('coord|locks?|presence'),
    ],
  },
  {
    id: 'deploy-release',
    label: 'deploy/rollback/release',
    risk: 'a deploy or rollback could ship the wrong build or fail to recover',
    patterns: [/(^|\/)lib\/release\//, seg('deploy|rollback|release')],
  },
];

export const CRITICAL_AREAS: readonly CriticalArea[] = RULES.map(({ id, label, risk }) => ({ id, label, risk }));

/** PURE: the critical area a test file (or gate leg id) belongs to, or null when none. */
export function classifyCriticalArea(testFile: string): CriticalArea | null {
  const path = testFile.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path) return null;
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(path))) {
      return { id: rule.id, label: rule.label, risk: rule.risk };
    }
  }
  return null;
}

/** The minimum length of the written risk statement: a word or two is not an acknowledgement. */
export const RISK_ACKNOWLEDGEMENT_MIN_CHARS = 20;

export interface CriticalAreaAcknowledgement {
  area?: string | null;
  risk?: string | null;
}

/**
 * PURE: why an acknowledgement does NOT cover `area`, or null when it does. It must name
 * the same area id and state the risk in at least RISK_ACKNOWLEDGEMENT_MIN_CHARS characters.
 */
export function criticalAreaAcknowledgementProblem(
  area: CriticalArea,
  acknowledgement: CriticalAreaAcknowledgement | null | undefined,
): string | null {
  if (!acknowledgement) {
    return `missing acknowledgement: this test is in the critical area '${area.id}' (${area.label}); pass acknowledgement { area: '${area.id}', risk: '<what may break and why you accept it>' }`;
  }
  const named = String(acknowledgement.area ?? '').trim();
  if (named !== area.id) {
    return `acknowledgement names area '${named || '(none)'}', but this test is in '${area.id}' (${area.label})`;
  }
  const risk = String(acknowledgement.risk ?? '').trim();
  if (risk.length < RISK_ACKNOWLEDGEMENT_MIN_CHARS) {
    return `acknowledgement risk is ${risk.length} chars; state the risk you accept in at least ${RISK_ACKNOWLEDGEMENT_MIN_CHARS}`;
  }
  return null;
}

/** The forceful warning D-006 requires, shown on every critical-area downgrade. */
export function criticalAreaWarning(area: CriticalArea): string {
  return (
    `⚠ CRITICAL AREA — ${area.label}. This downgrade lets main promote while this test fails, ` +
    `so main may ship broken behaviour in ${area.label}: ${area.risk}. The owner has been notified.`
  );
}
