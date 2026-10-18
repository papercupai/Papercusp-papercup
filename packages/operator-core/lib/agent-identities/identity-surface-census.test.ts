/**
 * identity-surface-census (identity-system-everything-migration-2026-10-18 P-001).
 * The checked-in inventory must equal a fresh derivation, every class must find its
 * known anchors, identity documents must stay out, and each detector must fire on a
 * seeded new surface (the property the P-005 shrink-only lint relies on, R-16).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_SURFACE_CENSUS_GENERATOR,
  IDENTITY_SURFACE_CENSUS_REL,
  SU_RENDER_PARITY_BASELINE,
  classifyHookSource,
  defaultCensusRoot,
  deriveIdentitySurfaceCensus,
  describeIdentitySurfaceCensusDiff,
  detectPromptConstants,
  diffIdentitySurfaceCensus,
  isExcludedOperatorPrompt,
  isIdentityBlueprint,
  renderIdentitySurfaceCensus,
  spliceMarkerNames,
  type IdentitySurfaceCensus,
  type IdentitySurfaceEntry,
} from './identity-surface-census';

const root = defaultCensusRoot();
const census = deriveIdentitySurfaceCensus(root);
const ids = new Set(census.entries.map((e) => e.id));

describe('identity-surface census — the checked-in inventory', () => {
  it('equals a fresh derivation (drift names each surface and the regen command)', () => {
    const checkedIn = readFileSync(join(root, IDENTITY_SURFACE_CENSUS_REL), 'utf8');
    const drift = describeIdentitySurfaceCensusDiff(diffIdentitySurfaceCensus(JSON.parse(checkedIn) as IdentitySurfaceCensus, census));
    expect(drift, `identity-surface census drifted — run: ${IDENTITY_SURFACE_CENSUS_GENERATOR}`).toEqual([]);
    expect(checkedIn, `identity-surface census metadata drifted — run: ${IDENTITY_SURFACE_CENSUS_GENERATOR}`).toBe(renderIdentitySurfaceCensus(census));
  });

  it('counts are consistent with the entries and every class is populated', () => {
    for (const [cls, n] of Object.entries(census.counts)) {
      expect(n, cls).toBeGreaterThan(0);
      expect(census.entries.filter((e) => e.class === cls)).toHaveLength(n);
    }
    expect(Object.values(census.hookKinds).reduce((a, b) => a + b, 0)).toBe(census.counts['injection-hook']);
  });

  it('records the su render parity baseline as IDOP’s frozen render, not a second one (D-008)', () => {
    expect(census.suRenderParityBaseline).toBe(SU_RENDER_PARITY_BASELINE);
    expect(SU_RENDER_PARITY_BASELINE).toContain('identity-definitions-own-policy-2026-10-17#P-001');
  });
});

describe('identity-surface census — known anchors per class', () => {
  it.each([
    'flat-role-prompt:libs/papercusp/packages/harness/blueprints/base/prompts/judge.md',
    'flat-role-prompt:libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
    'flat-role-prompt:apps/operator/prompts/papercup.persona.md',
    'prompt-constant:libs/papercusp/packages/orchestrator/src/prompt-build.ts#FRICTION_TRIPWIRE',
    'prompt-constant:libs/papercusp/packages/orchestrator/src/prompt-build.ts#OBSERVATION_RUBRIC_NUDGE',
    'prompt-constant:packages/operator-core/lib/turn-end-observation-policy.ts#TURN_END_OBSERVATION',
    'injection-hook:apps/operator/scripts/hooks/cc/posttooluse-ts-parse-nudge.mjs',
    'injection-hook:apps/operator/scripts/hooks/cc/pretooluse-secrets-guard.mjs',
    'kernel-splice:libs/papercusp/packages/harness/blueprints/base/prompts/su.md#WORKSPACE-MAP',
  ])('includes %s', (id) => {
    expect(ids.has(id)).toBe(true);
  });

  it('classifies a nudge as context and a secrets guard as a guard', () => {
    const byPath = (p: string) => census.entries.find((e) => e.path.endsWith(p))!;
    expect(byPath('posttooluse-ts-parse-nudge.mjs').kind).toBe('context');
    expect(byPath('pretooluse-secrets-guard.mjs').kind).toBe('guard');
  });
});

describe('identity-surface census — identity documents stay out', () => {
  it.each([
    'libs/papercusp/packages/harness/blueprints/papercusp-engineer/prompts/agent-base-overlay.md',
    'libs/papercusp/packages/harness/blueprints/base/prompts/agent-base-preamble.md',
    'libs/papercusp/packages/harness/blueprints/base/prompts/su.kernel.md',
    'libs/papercusp/packages/harness/blueprints/base/prompts/su.practice.md',
  ])('%s is not a flat role prompt', (path) => {
    expect(census.entries.some((e) => e.path === path)).toBe(false);
  });

  it('a blueprint is an identity exactly when it declares top-level slots', () => {
    expect(isIdentityBlueprint('id: x\nslots:\n  - slot: domain\n')).toBe(true);
    expect(isIdentityBlueprint('id: x\nroles: []\n')).toBe(false);
  });

  it('excludes human tutorial chapters, READMEs and pot-instance overrides', () => {
    expect(isExcludedOperatorPrompt('tutorial/ch1/01-x.md')).toBe(true);
    expect(isExcludedOperatorPrompt('power-user-skills/README.md')).toBe(true);
    expect(isExcludedOperatorPrompt('pot-instances/papercup-pot.su.md')).toBe(true);
    expect(isExcludedOperatorPrompt('papercup.persona.md')).toBe(false);
  });
});

describe('identity-surface census — detectors fire on a seeded new surface', () => {
  const longYou = `You must always do this. ${'Your work matters here. '.repeat(20)}`;

  it('detects a second-person prompt constant in array/join form', () => {
    const src = `export const NEW_BEHAVIOR_NOTE = [\n  ${JSON.stringify(longYou)},\n  'more',\n].join('\\n');\n`;
    expect(detectPromptConstants('packages/x/new.ts', src)).toEqual([
      expect.objectContaining({ id: 'prompt-constant:packages/x/new.ts#NEW_BEHAVIOR_NOTE', kind: 'second-person' }),
    ]);
  });

  it('detects a prompt-named constant with no second person', () => {
    const src = `const JUDGE_SYSTEM_PROMPT = \`${'Grade the subject against the rubric. '.repeat(12)}\`;\n`;
    expect(detectPromptConstants('packages/x/judge.ts', src).map((e) => e.kind)).toEqual(['prompt-named']);
  });

  it('ignores short text, SQL-shaped constants, lower-case names and function-local constants', () => {
    const sql = `const INSERT_SQL = \`${'INSERT INTO t (a, b) VALUES ($1, $2); '.repeat(12)}\`;`;
    const short = `const SHORT_NOTE = 'You and you.';`;
    const lower = `const helperText = ${JSON.stringify(longYou)};`;
    const local = `function f() { const INNER_NOTE = ${JSON.stringify(longYou)}; return INNER_NOTE; }`;
    expect(detectPromptConstants('packages/x/y.ts', [sql, short, lower, local].join('\n'))).toEqual([]);
  });

  it('classifies hook entrypoints deterministically', () => {
    expect(classifyHookSource('sessionstart-identity-context.sh', 'node "$HOOKS/inject/index.mjs" session-start')).toBe('identity-dispatch');
    expect(classifyHookSource('pretooluse-new-guard.mjs', 'out({ hookSpecificOutput: { permissionDecision: "deny" } })')).toBe('guard');
    expect(classifyHookSource('guard-operator-desktop.mjs', 'process.exit(2); // exit 2')).toBe('guard');
    expect(classifyHookSource('posttooluse-new-thing.mjs', 'print({ additionalContext: msg })')).toBe('context');
    expect(classifyHookSource('posttooluse-new-nudge.mjs', 'console.log(msg)')).toBe('context');
    expect(classifyHookSource('lifecycle-report.sh', 'curl -s "$URL" >/dev/null')).toBe('plumbing');
  });

  it('finds splice markers once per name, BEGIN/END folded, the client seam excluded', () => {
    const text = [
      '<!-- PAPERCUSP-SU:WORKSPACE-MAP:BEGIN -->',
      'x',
      '<!-- PAPERCUSP-SU:WORKSPACE-MAP:END -->',
      '<!-- PAPERCUSP-SU:NEW-SPLICE -->',
      '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->',
    ].join('\n');
    expect(spliceMarkerNames(text)).toEqual(['WORKSPACE-MAP', 'NEW-SPLICE']);
  });
});

describe('identity-surface census — diff', () => {
  const e = (id: string, kind = 'k'): IdentitySurfaceEntry => ({ class: 'prompt-constant', id, path: 'p.ts', kind });

  it('reports added, removed and changed surfaces', () => {
    const diff = diffIdentitySurfaceCensus({ entries: [e('a'), e('b'), e('c')] }, { entries: [e('b'), e('c', 'other'), e('d')] });
    expect(diff.added.map((x) => x.id)).toEqual(['d']);
    expect(diff.removed.map((x) => x.id)).toEqual(['a']);
    expect(diff.changed.map((x) => x.id)).toEqual(['c']);
    expect(describeIdentitySurfaceCensusDiff(diff)).toEqual(['+ d (k)', '- a (k)', '~ c (k → other)']);
  });

  it('is empty when nothing moved', () => {
    expect(describeIdentitySurfaceCensusDiff(diffIdentitySurfaceCensus(census, census))).toEqual([]);
  });
});
