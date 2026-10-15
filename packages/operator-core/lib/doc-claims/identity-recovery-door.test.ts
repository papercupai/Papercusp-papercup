/**
 * WI-10002028 / EI-23768233018723089 / WI-10002062. CLAUDE.md tells a toolless
 * agent that an `Identity capability (unresolved): stale-artifact` denial is
 * opened by `coord:orient`, NOT by scripts/mcp-call.mjs. That is a claim about
 * CODE, so it is pinned here rather than left as prose: if someone re-seals the
 * recovery door, the doc would go on confidently routing bricked sessions
 * through a verb that no longer works, and a bricked session is the one state
 * that cannot report the discrepancy.
 *
 * ## Why this guard was rewritten (WI-10002062) — read before changing it
 *
 * The first version counted one literal: exactly one `denial('stale-artifact'`
 * had to exist, inside the helper. That encoded the architecture of the day —
 * six sites each denying independently, one of which had been fixed. When
 * EI-23768233018723089 routed EVERY site through a single chokepoint and moved
 * the door's identity into a dependency-free module, the token it counted
 * stopped existing and the guard went red against a tree that had strictly
 * IMPROVED on the property it protects.
 *
 * Red was the lucky direction. The same staleness one step further — a renamed
 * constructor that still bypasses the chokepoint — would have counted zero
 * occurrences of a token nobody writes any more and passed silently forever,
 * which is a guard that cannot fail: the exact wrong-edge instrument this class
 * of defect keeps producing. A guard pinned to one spelling of one cause at one
 * call site measures a SNAPSHOT, not a property.
 *
 * So the assertions below are written over the CLASS, derived from the contract
 * rather than from remembered instances:
 *   1. the door's identity lives in a module that cannot fail the way the gate
 *      fails (zero imports), and the port reaches it from there;
 *   2. for EVERY break-glass cause — read from the port's own IDENTITY_BREAK_GLASS
 *      declaration, not hand-listed — every denial CONSTRUCTED with that cause
 *      goes through the chokepoint;
 *   3. every cause in the IdentityGrantFailure union is explicitly classified
 *      break-glass or not, so a NEW cause forces a decision instead of silently
 *      defaulting to "seals the door";
 *   4. every known single-target dispatch wrapper is classified in the door
 *      module, so a new ROUTE to the door cannot appear unconsidered.
 *
 * ⚠ (2) deliberately asserts over DISPATCH reachability, not IMPORT reachability.
 * The parent item specified a static assertion that "the module graph reachable
 * from the recovery verb does not include the capability-gate module". Measured
 * 2026-09-20: that assertion passes against a tree where the defect is LIVE —
 * coord:orient's import graph genuinely excludes identity-grants-port.ts,
 * because the coupling runs through the dispatcher, which calls the gate for
 * every tool before dispatch. Implementing it as written would have installed a
 * guard that is green while sessions brick, and the parent's own falsifier
 * ("green ⇒ drop the idea") would then have retired a real defect. See
 * EI-23768233018723089 comment:431993.
 *
 * ## (4) sits on the PIN rung, not the DERIVE rung — on purpose
 *
 * A fully derived wrapper set would be better, and is not available: the
 * obvious seam (`ctx.dispatchTool`) does not discriminate. gitnexus:query,
 * scorecards:emit, harness:generate_from_repo and coord:orient itself all
 * dispatch other tools incidentally without being wrappers. What makes a
 * wrapper RELEVANT here is narrower — its declared args carry the target tool's
 * NAME, so the target is verifiable before dispatch. That is a property of a
 * tool's schema, and no registry of it exists yet. Until one does, the set is
 * pinned and each member is checked to be a real registration, so a rename goes
 * red even though an ADDITION still relies on whoever adds it reading this.
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once
 * the live assertion goes green it stops being evidence that the detector works
 * at all. Each fixture reproduces a shape that MUST be caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PORT = join(ROOT, 'packages/operator-core/lib/capability-envelope/identity-grants-port.ts');
const DOOR = join(ROOT, 'packages/operator-core/lib/capability-envelope/recovery-door.ts');
const ENVELOPES = join(ROOT, 'packages/operator-core/lib/capability-envelope/blueprint-envelopes.ts');
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');

const RECOVERY_TOOL = 'coord:orient';

/** The chokepoint every break-glass denial must be constructed through. */
const CHOKEPOINT = 'denyUnlessRecoveryDoor';

/**
 * Causes that are correct to enforce against every verb, each with the reason
 * it is NOT self-sealing. This is the explicit half of assertion (3): a cause
 * appearing in the union but in neither this map nor IDENTITY_BREAK_GLASS is a
 * violation, so adding one forces a decision rather than defaulting to "seals".
 */
const NON_BREAK_GLASS_CAUSES: Record<string, string> = {
  'policy-unavailable':
    'transient infrastructure; running the recovery verb would not clear it, and the ' +
    'kernel resolver consults the door module directly on this path instead',
  'provider-unbound': 'a statement about authority, not about which specification is in force',
  'provider-changed': 'a statement about authority, not about which specification is in force',
  'tool-unavailable': 'a statement about authority, not about which specification is in force',
  'outside-ceiling':
    'honouring a ceiling that genuinely excludes the recovery verb is not self-sealing',
};

/**
 * Single-target dispatch wrappers. Each must be classified in the door module —
 * recognised as a route, or named as deliberately excluded. See the PIN-rung
 * note in the file docblock for why this is not derived.
 */
const KNOWN_DISPATCH_WRAPPERS = ['tools:invoke', 'code:run', 'recipes:run'] as const;

/** Blank out comments so prose mentioning a cause is never read as a call site. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'tick' = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'tick';
      out += ch; i++; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; } else out += ' ';
      i++; continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? ch : ' '; i++; continue;
    }
    // inside a string literal
    if (ch === '\\') { out += '  '; i += 2; continue; }
    if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"') ||
        (mode === 'tick' && ch === '`')) mode = 'code';
    out += ch; i++; continue;
  }
  return out;
}

/**
 * The identifier of the call whose argument list encloses `index`, or null when
 * the position is not inside a call (a declaration, an array literal, a
 * comparison). Walks backwards over balanced parens so nested calls in earlier
 * arguments do not confuse the match.
 */
/**
 * A control-flow keyword is NOT a callee. `if (x === 'stale-artifact')` puts the
 * literal inside parentheses whose nearest preceding word is `if`, so without
 * this the walker reports `if(...)` as the constructing function and the guard
 * fires on a plain COMPARISON — which constructs no denial at all.
 *
 * This does not weaken check (2). A real construction — `someDeny(request,
 * 'stale-artifact')` — puts its own `(` nearer to the literal than the
 * enclosing `if (`, so the call is still found first; the keyword is only ever
 * reached when the literal sits in no call at all.
 */
const NOT_A_CALLEE = new Set(['if', 'while', 'for', 'switch', 'catch', 'return', 'typeof', 'await']);

export function enclosingCallee(source: string, index: number): string | null {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ')') { depth++; continue; }
    if (ch !== '(') continue;
    if (depth > 0) { depth--; continue; }
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j])) j--;
    const end = j + 1;
    while (j >= 0 && /[\w$.]/.test(source[j])) j--;
    const word = source.slice(j + 1, end);
    return !word || NOT_A_CALLEE.has(word) ? null : word;
  }
  return null;
}

/** Break-glass causes, read from the port's own declaration rather than hand-listed. */
export function parseBreakGlassCauses(portSource: string): string[] {
  const block = /causes:\s*\[([^\]]*)\]/.exec(stripComments(portSource));
  if (!block) return [];
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Every cause the port can raise. The single truth is the const list
 * IDENTITY_GRANT_FAILURE_CAUSES (the IdentityGrantFailure union derives from it —
 * EI-23766133296678780 moved it there so the refusal-contract table can derive from
 * it too). An inline `cause: 'a' | 'b'` union is still read, so a regression back to
 * the old shape stays covered. An empty parse of BOTH shapes stays a loud violation.
 */
export function parseCauseUnion(envelopesSource: string): string[] {
  const code = stripComments(envelopesSource);
  const list = /\bIDENTITY_GRANT_FAILURE_CAUSES\s*=\s*\[([^\]]*)\]/.exec(code);
  if (list) return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const decl = /\bcause:\s*((?:'[^']+'\s*\|\s*)*'[^']+')\s*;/.exec(code);
  if (!decl) return [];
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export interface Verdict { ok: boolean; violations: string[]; breakGlassCauses: string[] }

export function judgeRecoveryDoorFailureDomain(input: {
  portSource: string; doorSource: string; envelopesSource: string;
}): Verdict {
  const violations: string[] = [];
  const port = stripComments(input.portSource);
  const breakGlassCauses = parseBreakGlassCauses(input.portSource);

  // (1) The door's identity must live where it cannot fail with the gate.
  if (!input.doorSource.includes(`RECOVERY_DOOR_TOOL = '${RECOVERY_TOOL}'`)) {
    violations.push(
      `the door module no longer names ${RECOVERY_TOOL} as RECOVERY_DOOR_TOOL, so the door CLAUDE.md sends bricked sessions to is gone`,
    );
  }
  if (/^\s*import\s/m.test(stripComments(input.doorSource))) {
    violations.push(
      'recovery-door.ts has acquired an import — it must stay dependency-free, or it gains a way to be unloadable for the same reason the gate was',
    );
  }
  if (!/from\s+'\.\/recovery-door'/.test(port)) {
    violations.push(
      'the port no longer reaches the door identity from ./recovery-door, so the fail-closed catch has nothing to ask when the gate module itself fails to load',
    );
  }

  // A parse that silently found nothing would make every check below vacuous.
  if (breakGlassCauses.length === 0) {
    violations.push(
      'could not read IDENTITY_BREAK_GLASS.causes from the port — this guard cannot verify anything without it (a vacuous pass is the failure mode it exists to prevent)',
    );
  }

  // (2) Every denial CONSTRUCTED with a break-glass cause goes through the chokepoint.
  for (const cause of breakGlassCauses) {
    const needle = `'${cause}'`;
    for (let at = port.indexOf(needle); at !== -1; at = port.indexOf(needle, at + 1)) {
      const callee = enclosingCallee(port, at);
      // null = a declaration, array literal or comparison, not a construction.
      if (callee === null || callee === CHOKEPOINT) continue;
      violations.push(
        `${cause} is denied by ${callee}(...) rather than ${CHOKEPOINT}(...) — that site bypasses the chokepoint and re-seals the recovery door for its path`,
      );
    }
  }

  // (3) Every cause in the union is explicitly classified.
  const union = parseCauseUnion(input.envelopesSource);
  if (union.length === 0) {
    violations.push('could not read the IdentityGrantFailure cause union — classification is unverifiable');
  }
  for (const cause of union) {
    if (breakGlassCauses.includes(cause)) continue;
    if (cause in NON_BREAK_GLASS_CAUSES) continue;
    violations.push(
      `cause '${cause}' is in the IdentityGrantFailure union but classified nowhere — add it to IDENTITY_BREAK_GLASS.causes, or to NON_BREAK_GLASS_CAUSES with the reason it is not self-sealing. Defaulting is how a self-sealing cause gets one`,
    );
  }

  // (4) Every known dispatch wrapper is classified in the door module.
  for (const wrapper of KNOWN_DISPATCH_WRAPPERS) {
    if (!input.doorSource.includes(wrapper)) {
      violations.push(
        `dispatch wrapper '${wrapper}' is not classified in recovery-door.ts — each wrapper is a ROUTE to the door and must be either recognised or explicitly excluded with its reason`,
      );
    }
  }

  return { ok: violations.length === 0, violations, breakGlassCauses };
}

const liveInput = () => ({
  portSource: readFileSync(PORT, 'utf8'),
  doorSource: readFileSync(DOOR, 'utf8'),
  envelopesSource: readFileSync(ENVELOPES, 'utf8'),
});

const FIXTURE_DOOR = `
export const RECOVERY_DOOR_TOOL = '${RECOVERY_TOOL}';
export const RECOVERY_DOOR_DISPATCH_WRAPPER = 'tools:invoke';
// code:run and recipes:run forward sequences, deliberately not recognised.
`;
const FIXTURE_ENVELOPES = `
export interface IdentityGrantFailure {
  cause: 'stale-artifact' | 'no-launch-record' | 'policy-unavailable' | 'provider-unbound' | 'provider-changed' | 'tool-unavailable' | 'outside-ceiling';
}
`;
const FIXTURE_PORT_OK = `
import { RECOVERY_DOOR_TOOL } from './recovery-door';
export const IDENTITY_BREAK_GLASS = { causes: ['stale-artifact', 'no-launch-record'] };
function staleArtifact(request) { return ${CHOKEPOINT}(request, 'stale-artifact', null); }
function missing(request) { return ${CHOKEPOINT}(request, 'no-launch-record', null); }
`;

describe('CLAUDE.md identity-recovery-door claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a site that constructs a break-glass denial outside the chokepoint', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        doorSource: FIXTURE_DOOR, envelopesSource: FIXTURE_ENVELOPES,
        portSource: `${FIXTURE_PORT_OK}\nfunction check(request) { return denial(request, 'stale-artifact', null); }`,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/denied by denial\(\.\.\.\).*re-seals the recovery door/);
    });

    it('catches the OTHER break-glass cause bypassing it — the hole the old guard had', () => {
      // The previous guard counted only stale-artifact, so a raw no-launch-record
      // site sailed through it. Deriving the causes is what closes that.
      const verdict = judgeRecoveryDoorFailureDomain({
        doorSource: FIXTURE_DOOR, envelopesSource: FIXTURE_ENVELOPES,
        portSource: `${FIXTURE_PORT_OK}\nfunction check(request) { return denial(request, 'no-launch-record', null); }`,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no-launch-record is denied by denial/);
    });

    it('catches a NEW cause added to the union but classified nowhere', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, doorSource: FIXTURE_DOOR,
        envelopesSource: FIXTURE_ENVELOPES.replace(
          "'outside-ceiling'", "'outside-ceiling' | 'specification-unreadable'",
        ),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/'specification-unreadable'.*classified nowhere/);
    });

    // EI-23766133296678780: the cause list now lives in a const array the union derives
    // from. The parser must read THAT shape, and a new cause added to it must still be
    // caught as unclassified — otherwise moving the list silently vacated check (3).
    const ARRAY_ENVELOPES = `
export const IDENTITY_GRANT_FAILURE_CAUSES = [
  'stale-artifact', 'no-launch-record', 'policy-unavailable', 'provider-unbound',
  'provider-changed', 'tool-unavailable', 'outside-ceiling',
] as const;
export type IdentityGrantFailureCause = (typeof IDENTITY_GRANT_FAILURE_CAUSES)[number];
export interface IdentityGrantFailure { cause: IdentityGrantFailureCause; }
`;

    it('reads the cause list from the IDENTITY_GRANT_FAILURE_CAUSES const array', () => {
      expect(parseCauseUnion(ARRAY_ENVELOPES)).toEqual([
        'stale-artifact', 'no-launch-record', 'policy-unavailable', 'provider-unbound',
        'provider-changed', 'tool-unavailable', 'outside-ceiling',
      ]);
      expect(judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, doorSource: FIXTURE_DOOR, envelopesSource: ARRAY_ENVELOPES,
      })).toMatchObject({ ok: true });
    });

    it('catches a NEW cause added to the const array but classified nowhere', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, doorSource: FIXTURE_DOOR,
        envelopesSource: ARRAY_ENVELOPES.replace("'outside-ceiling',", "'outside-ceiling', 'specification-unreadable',"),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/'specification-unreadable'.*classified nowhere/);
    });

    it('still reports an unreadable cause list when neither shape is present', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, doorSource: FIXTURE_DOOR,
        envelopesSource: 'export interface IdentityGrantFailure { cause: string; }',
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/could not read the IdentityGrantFailure cause union/);
    });

    it('catches the door module acquiring an import', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, envelopesSource: FIXTURE_ENVELOPES,
        doorSource: `import { x } from './sibling';\n${FIXTURE_DOOR}`,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/must stay dependency-free/);
    });

    it('catches the door being removed outright — the pre-WI-10002028 state', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, envelopesSource: FIXTURE_ENVELOPES,
        doorSource: FIXTURE_DOOR.replace(`RECOVERY_DOOR_TOOL = '${RECOVERY_TOOL}'`, 'RECOVERY_DOOR_TOOL = null'),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no longer names coord:orient/);
    });

    it('catches a dispatch wrapper left unclassified by the door module', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, envelopesSource: FIXTURE_ENVELOPES,
        doorSource: FIXTURE_DOOR.replace('code:run and recipes:run', 'recipes:run'),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/'code:run' is not classified/);
    });

    it('passes a port that routes every break-glass cause through the chokepoint', () => {
      expect(judgeRecoveryDoorFailureDomain({
        portSource: FIXTURE_PORT_OK, doorSource: FIXTURE_DOOR, envelopesSource: FIXTURE_ENVELOPES,
      })).toMatchObject({ ok: true, breakGlassCauses: ['stale-artifact', 'no-launch-record'] });
    });

    // WI-10002060: a COMPARISON is not a construction. `if (k === 'stale-artifact')`
    // sits inside the parens of `if`, so the callee walker used to report `if(...)`
    // and the guard fired on code that denies nothing. It is a false positive, and
    // a permanently-red guard is one somebody eventually deletes.
    it('does not flag a comparison against a break-glass cause inside an if', () => {
      expect(judgeRecoveryDoorFailureDomain({
        portSource: `${FIXTURE_PORT_OK}\nfunction dispatch(r, k) { if (k === 'stale-artifact') return staleArtifact(r); return null; }`,
        doorSource: FIXTURE_DOOR, envelopesSource: FIXTURE_ENVELOPES,
      })).toMatchObject({ ok: true });
    });

    // The paired control: the keyword exemption must not become a hiding place.
    // A real denial CONSTRUCTED inside an if-condition is still caught, because
    // its own `(` is nearer to the literal than the enclosing `if (`.
    it('still flags a denial constructed inside an if-condition', () => {
      const verdict = judgeRecoveryDoorFailureDomain({
        portSource: `${FIXTURE_PORT_OK}\nfunction dispatch(r) { if (sneakyDeny(r, 'stale-artifact')) return null; }`,
        doorSource: FIXTURE_DOOR, envelopesSource: FIXTURE_ENVELOPES,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/denied by sneakyDeny\(\.\.\.\)/);
    });
  });

  it('holds against the live sources', () => {
    const verdict = judgeRecoveryDoorFailureDomain(liveInput());
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('reads a non-empty break-glass set from the live port', () => {
    // Positive control: every per-cause assertion above is vacuous if this is
    // empty, so an empty parse must be loud rather than a silent green.
    expect(judgeRecoveryDoorFailureDomain(liveInput()).breakGlassCauses.length).toBeGreaterThan(0);
  });

  it('keeps the projected doc pointing at the door that actually opens', () => {
    const doc = readFileSync(CLAUDE_MD, 'utf8');
    // The identity class must name the resync verb...
    expect(doc).toContain(`${RECOVERY_TOOL} { afterCompaction: true }`);
    // ...and must explicitly refuse the transport fallback for this class, so an
    // agent cannot read mcp-call.mjs as the remedy the way WI-10002028 reported.
    expect(doc).toMatch(/mcp-call\.mjs` CANNOT open this one/);
  });
});
