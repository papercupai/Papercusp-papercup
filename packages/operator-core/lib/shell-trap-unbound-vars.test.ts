import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A `trap` body in a `set -u` script may not expand a variable that is assigned
 * only AFTER the trap is installed.
 *
 * ── WHY (EI-20277106438978584) ──────────────────────────────────────────────
 *
 * `scripts/pc-heavy.sh` runs under `set -uo pipefail`. Its coalesce leader
 * installed:
 *
 *     trap 'rm -rf "$_c_lockdir" 2>/dev/null; rm -f "$_c_out_tmp" "$_c_err_tmp" 2>/dev/null' EXIT
 *
 * `_c_out_tmp` and `_c_err_tmp` are assigned ~190 lines later, once the leader
 * actually starts running. The trap's own comment said "Unset here, so this is
 * a no-op on every path that never becomes a leader" — but `set -u` makes
 * expanding an unset name an ABORT, not an empty expansion. So the comment
 * described behaviour the shell cannot deliver, and nothing failed until a job
 * was killed while still QUEUED, which then exited printing
 * `pc-heavy.sh: line 1: _c_out_tmp: unbound variable` at the tail of the
 * caller's own output — reading as a fault in the agent's command, from the
 * very wrapper that exists to reduce that confusion. The trap also aborted
 * partway through its cleanup list; only the ordering of that list (lockdir
 * removal came first) kept it harmless.
 *
 * A trap body is exactly where this hides: it runs at a time nobody chose, on
 * paths nobody exercises, so the ordinary run never touches it.
 *
 * ── WHY THE RULE IS ASSIGNMENT-ORDER, NOT "ALWAYS GUARD" ────────────────────
 *
 * The blunt rule — every expansion in a trap must use `${v:-}` — was measured
 * against this tree first and would flag three sites that are all CORRECT
 * (`pc-heavy.sh`'s own `$_c_lockdir`, assigned 141 lines BEFORE its trap;
 * `verify-learning-tab-views.sh`'s `$DRIVE`; `wi6743-stall-sampler.sh`'s
 * `$PROBE_PID`). A guard whose first act is three false positives teaches
 * people to suppress it. The order rule flags the real defect and clears all
 * three, so what it reports is worth reading.
 *
 * Fail direction: a name this cannot prove is pre-assigned IS reported. The fix
 * is always the same one character-pair (`${v:-}`), so a false positive costs a
 * guard expansion, while a false negative costs another silent abort on a path
 * only reachable under load.
 *
 * Known bound, stated rather than hidden: assignments are matched textually, so
 * a name assigned only inside a function defined before the trap but CALLED
 * after it reads as pre-assigned. Every trap site in this tree today is a
 * straight-line assignment; revisit if that stops being true.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN_ROOTS = ['scripts', 'bin'];

/** `set -u`, `set -eu`, `set -uo pipefail`, `set -o nounset`. */
const ENABLES_NOUNSET = /^\s*set\s+-[a-z]*u|^\s*set\s+-o\s+nounset/m;

/** Shell specials — never user variables, never unbound in this sense. */
const SHELL_SPECIALS = new Set(['IFS', 'PWD', 'HOME', 'PATH', 'LINENO', 'FUNCNAME', 'BASH_SOURCE', 'PPID']);

/**
 * Deliberate exemptions keyed `<file>:<line>:<var>`, each with a reason. EMPTY
 * on purpose. An entry here says a trap may abort partway through its cleanup —
 * say why that is acceptable.
 */
const ALLOW: Record<string, string> = {};

export const shellScripts = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, depth + 1);
      else if (entry.name.endsWith('.sh')) found.push(rel);
    }
  };
  for (const root of SCAN_ROOTS) walk(root, 0);
  return found;
};

export type TrapSite = { line: number; body: string };

/** Quoted `trap '<body>' SIG` sites. Multi-line bodies included. */
export const trapSites = (src: string): TrapSite[] => {
  const sites: TrapSite[] = [];
  for (const m of src.matchAll(/\btrap\s+(["'])([\s\S]*?)\1/g)) {
    sites.push({ line: src.slice(0, m.index ?? 0).split('\n').length, body: m[2] });
  }
  return sites;
};

/** Names expanded WITHOUT a `:-` / `:+` / `-` / `?` default in this body. */
export const unguardedNames = (body: string): string[] => {
  const names = new Set<string>();
  for (const m of body.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const name = m[1];
    if (SHELL_SPECIALS.has(name)) continue;
    if (new RegExp(`\\$\\{${name}[:\\-+?]`).test(body)) continue;
    names.add(name);
  }
  return [...names];
};

/** 1-based line of the first textual assignment, or Infinity if never. */
export const firstAssignmentLine = (lines: string[], name: string): number => {
  const assign = new RegExp(
    `^\\s*(?:export\\s+|local\\s+|declare\\s+(?:-[a-zA-Z]+\\s+)?|readonly\\s+)?${name}=` +
      `|^\\s*read\\s+[^#]*\\b${name}\\b` +
      `|^\\s*for\\s+${name}\\s+in\\b`,
  );
  for (let i = 0; i < lines.length; i++) if (assign.test(lines[i])) return i + 1;
  return Number.POSITIVE_INFINITY;
};

/**
 * Names expanded before a simple, unconditional assignment in the trap body.
 * Only a leading sequence of assignment commands is treated as definite; the
 * scanner deliberately does not infer initialization from conditional branches.
 */
const unassignedTrapNames = (body: string): string[] => {
  const assigned = new Set<string>();
  const unassigned = new Set<string>();
  let assignmentPrefix = true;

  for (const command of body.split(/[;\n]/)) {
    if (command.trim() === '') continue;
    const assignment = assignmentPrefix
      ? command.match(
          /^\s*(?:(?:export\s+|local\s+|declare\s+(?:-[a-zA-Z]+\s+)?|readonly\s+))?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
        )
      : null;

    if (assignment) {
      for (const name of unguardedNames(assignment[2])) {
        if (!assigned.has(name)) unassigned.add(name);
      }
      assigned.add(assignment[1]);
      continue;
    }

    assignmentPrefix = false;
    for (const name of unguardedNames(command)) {
      if (!assigned.has(name)) unassigned.add(name);
    }
  }

  return [...unassigned];
};

export const hazardsIn = (src: string, file = '<memory>'): string[] => {
  if (!ENABLES_NOUNSET.test(src)) return [];
  const lines = src.split('\n');
  const found: string[] = [];
  for (const site of trapSites(src)) {
    for (const name of unassignedTrapNames(site.body)) {
      const assigned = firstAssignmentLine(lines, name);
      if (assigned <= site.line) continue;
      if (`${file}:${site.line}:${name}` in ALLOW) continue;
      found.push(
        `${file}:${site.line} — trap expands $${name} unguarded, but it is first assigned at ` +
          `${assigned === Number.POSITIVE_INFINITY ? 'NO line' : `line ${assigned}`}. Use \${${name}:-}.`,
      );
    }
  }
  return found;
};

const scanned = (): { files: string[]; nounset: string[]; traps: number; expansions: number } => {
  const files = shellScripts();
  const nounset: string[] = [];
  let traps = 0;
  let expansions = 0;
  for (const file of files) {
    const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!ENABLES_NOUNSET.test(src)) continue;
    nounset.push(file);
    for (const site of trapSites(src)) {
      traps += 1;
      expansions += unguardedNames(site.body).length;
    }
  }
  return { files, nounset, traps, expansions };
};

/** The pre-fix pc-heavy trap, verbatim, in its real assignment order. */
const REAL_BUG = [
  'set -uo pipefail',
  '_c_lockdir="$dir/lock"',
  `trap 'rm -rf "$_c_lockdir" 2>/dev/null; rm -f "$_c_out_tmp" "$_c_err_tmp" 2>/dev/null' EXIT`,
  'run_the_thing',
  '_c_out_tmp="$_c_out.$$.part"',
  '_c_err_tmp="$_c_err.$$.part"',
].join('\n');

describe('trap bodies cannot abort on an unbound variable', () => {
  it('no shell script installs a trap over a not-yet-assigned variable', () => {
    const found: string[] = [];
    for (const file of shellScripts()) {
      found.push(...hazardsIn(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file));
    }
    expect(found).toEqual([]);
  });

  it('detects the real defect — the pre-fix pc-heavy trap, verbatim', () => {
    const found = hazardsIn(REAL_BUG, 'scripts/pc-heavy.sh');
    expect(found).toHaveLength(2);
    expect(found.join('\n')).toContain('$_c_out_tmp');
    expect(found.join('\n')).toContain('$_c_err_tmp');
  });

  it('clears the shipped fix — the same trap with :- guards', () => {
    expect(hazardsIn(REAL_BUG.replace('"$_c_out_tmp" "$_c_err_tmp"', '"${_c_out_tmp:-}" "${_c_err_tmp:-}"'))).toEqual([]);
  });

  it('does not flag a variable assigned BEFORE its trap', () => {
    // pc-heavy's own $_c_lockdir, and the two other sites in this tree. A
    // blunt "always guard" rule reports all three; each is correct code.
    expect(hazardsIn(REAL_BUG).join('\n')).not.toContain('_c_lockdir');
    expect(hazardsIn(['set -eu', 'PROBE_PID=$!', `trap 'kill "$PROBE_PID"' EXIT`].join('\n'))).toEqual([]);
  });

  it('recognizes an unconditional assignment before use in the trap body', () => {
    const src = [
      'set -u',
      "trap 'status=$?; if [ \"$status\" -ne 0 ]; then :; fi' EXIT",
    ].join('\n');
    expect(hazardsIn(src)).toEqual([]);
  });

  it('still flags a trap-body variable used before a later assignment', () => {
    const src = [
      'set -u',
      "trap 'if [ \"$status\" -ne 0 ]; then :; fi; status=$?' EXIT",
    ].join('\n');
    expect(hazardsIn(src)).toHaveLength(1);
  });

  it('ignores a script that does not enable nounset', () => {
    expect(hazardsIn(REAL_BUG.replace('set -uo pipefail', 'set -o pipefail'))).toEqual([]);
  });

  it('does not treat shell specials or positional params as variables', () => {
    expect(unguardedNames('echo "$?" "$1" "$$" "$IFS"')).toEqual([]);
  });

  it('scans a real, non-vacuous population — an empty result means clean, not absent', () => {
    // A scan-based guard that finds NOTHING to scan passes vacuously forever.
    // Zero hazards is the CURRENT truth, so the population is what proves the
    // scan actually looked. Trap sites are the load-bearing count: if the
    // extractor silently stopped matching, this is what fails.
    // Floors sit below the measured population (19 scripts / 18 nounset / 11
    // trap sites / 4 unguarded expansions as of 2026-08-12) so that adding or
    // removing one script does not fail this, while the extractor going quiet
    // does.
    const { files, nounset, traps, expansions } = scanned();
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(nounset.length).toBeGreaterThanOrEqual(12);
    expect(traps).toBeGreaterThanOrEqual(8);
    expect(expansions).toBeGreaterThanOrEqual(2);
  });
});
