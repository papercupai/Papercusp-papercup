/**
 * P-011(a) / D-011 CLASS GUARD (EI-25695434826164414).
 *
 * A live psu host is not proof that a session can take a turn. Any module that
 * derives a liveness verdict with POSITIVE psu-host authority (a live host
 * rescues the session to `parked` / `recorded`) must also run the oracle's
 * host-condition judge (`applyHostConditionLeg` or `applyHostCondition`).
 * Otherwise a dead-auth, quota-walled, unbound or stuck host reads `parked` on
 * that surface. coord:presence, fleet:assignments and the fleet roster each had
 * this bug in turn, one surface at a time; this test stops the next one.
 *
 * Module-level, not call-level: positive authority is often built in an options
 * object away from the `deriveVerdict(` call, so a module that derives AND sets
 * non-false `positive:` authority anywhere must call the judge somewhere.
 * Comments and string literals are blanked before matching, so prose that
 * mentions these names neither creates nor excuses an offender.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const LIB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DERIVES = /\bderiveVerdict\s*\(/;
/** `positive: <anything but false>` — an object key, never the optional type member `positive?:`. */
const POSITIVE_AUTHORITY = /\bpositive\s*:\s*(?!false\b)\S/;
const JUDGES = /\bapplyHostCondition(?:Leg)?\s*\(/;

type Classified = { derivesWithPositiveAuthority: boolean; judges: boolean };

function classify(source: string, fileName: string): Classified {
  const code = stripCommentsAndStrings(source, fileName);
  return {
    derivesWithPositiveAuthority: DERIVES.test(code) && POSITIVE_AUTHORITY.test(code),
    judges: JUDGES.test(code),
  };
}

function isGap(source: string, fileName = 'fixture.ts'): boolean {
  const c = classify(source, fileName);
  return c.derivesWithPositiveAuthority && !c.judges;
}

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.vitest-tmp', '__fixtures__'].includes(entry.name) ? [] : productionSources(path);
    }
    const isSource = entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
    const isTest = /\.(test|spec)\.ts$/.test(entry.name);
    return isSource && !isTest ? [path] : [];
  });
}

function census(): { positive: string[]; gaps: string[] } {
  const positive: string[] = [];
  const gaps: string[] = [];
  for (const path of productionSources(LIB_ROOT)) {
    const source = readFileSync(path, 'utf8');
    if (!source.includes('deriveVerdict')) continue; // cheap prefilter before a parse
    const c = classify(source, path);
    if (!c.derivesWithPositiveAuthority) continue;
    const rel = relative(LIB_ROOT, path).split('\\').join('/');
    positive.push(rel);
    if (!c.judges) gaps.push(rel);
  }
  return { positive: positive.sort(), gaps: gaps.sort() };
}

// Detector-shaped controls. They live in string literals inside a TEST file:
// the census skips test files, and stripping would blank them anyway, so they
// can never self-match the real scan.
const DERIVE_WITH_POSITIVE = `
  const v = deriveVerdict(subject, w, recordedLive, nowMs, undefined, {
    enabled: true, negative: false, positive: true, findHostFn,
  });`;
const LEG_CALL = `
  await applyHostConditionLeg(verdicts, subjects, { nowMs, findHostFn });`;

describe('host-condition coverage (P-011 class guard)', () => {
  it('controls: the detector flags a positive-authority derivation that never judges the host', () => {
    expect(isGap(DERIVE_WITH_POSITIVE)).toBe(true);
    expect(isGap(DERIVE_WITH_POSITIVE + LEG_CALL)).toBe(false);
    expect(isGap(DERIVE_WITH_POSITIVE + '\n  const x = applyHostCondition(v, condition);')).toBe(false);
    // Authority passed as a variable is still positive authority for the module.
    expect(isGap('const auth = { enabled: true, positive: opts.psu === true };\nderiveVerdict(s, w, r, n, undefined, auth);')).toBe(true);
    // Not positive authority: an explicit false, or a type member.
    expect(isGap(DERIVE_WITH_POSITIVE.replace('positive: true', 'positive: false'))).toBe(false);
    expect(isGap('interface A { positive?: boolean }\nderiveVerdict(s, w, r, n);')).toBe(false);
  });

  it('controls: names in comments or strings neither create nor excuse an offender', () => {
    // A judge mentioned only in a comment or a string does not count as a call.
    expect(isGap(DERIVE_WITH_POSITIVE + '\n  // applyHostConditionLeg(verdicts, subjects, deps)')).toBe(true);
    expect(isGap(DERIVE_WITH_POSITIVE + "\n  const s = 'applyHostCondition(v, c)';")).toBe(true);
    // A derivation mentioned only in prose is not a derivation.
    expect(isGap('/* deriveVerdict(s, w, r, n, undefined, { positive: true }) */ const x = 1;')).toBe(false);
  });

  it('calibration: the census still finds every known positive-authority surface', () => {
    const { positive } = census();
    // If this fails because a surface moved or was renamed, update the list; if it
    // fails because the census found nothing, the detector broke and the guard
    // below would pass vacuously.
    expect(positive).toEqual(
      expect.arrayContaining([
        'agent-tools/coordination/liveness-oracle.ts',
        'agent-tools/coordination/presence-snapshot.ts',
        'agent-tools/fleet/assignments.ts',
        'fleet/fleet-roster.ts',
      ]),
    );
  });

  it('every module that trusts a live host as proof of life also judges whether it can take a turn', () => {
    expect(census().gaps).toEqual([]);
  });
});
