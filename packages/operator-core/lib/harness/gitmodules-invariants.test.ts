import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOREIGN_HIVE_SUBMODULES } from '../../../../scripts/lib/foreign-hive-submodules.mjs';

/**
 * Recurrence guard for the 2026-06-25 "Setting up Papercusp workspace failed"
 * incident: the papercup→papercusp identity rename overreached into `.gitmodules`
 * and rewrote two submodule URLs to repos that were never actually renamed on
 * GitHub (`Papercusp/papercusp-db.git`, `Papercusp/papercusp-shared.git` → 404).
 * Every FRESH dogfood clone then failed submodule init with a bare "setup failed",
 * while the dev box was unaffected (its `.git/config` kept the correct URLs).
 *
 * These are load-bearing source submodules (34+ active imports of
 * `@papercusp/db-org` and `@papercusp/papercusp-shared`), so a stale URL is a
 * hard release blocker, not a cosmetic nit. This test parses the committed
 * `.gitmodules` and fails the build the instant a submodule URL points at a
 * known-dead name or regresses to HTTPS. Git-sync pushes every submodule origin;
 * SSH is the authenticated protocol already proven by the superproject on the
 * shared fleet, while GitHub rejects the HTTPS path when the account email is
 * unverified. Catching that protocol drift in CI prevents another fleet-wide
 * backlog of unreplicated submodule commits.
 *
 * See agent-insights/macos-packaged-app-path-and-git +
 * setup-wizard-github-network-timeout.
 */

function findRepoRoot(start: string): string {
  let dir = start;
  // Walk up until we find the superproject `.gitmodules` (it lists ~30 entries).
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, '.gitmodules');
    if (existsSync(candidate)) {
      const body = readFileSync(candidate, 'utf8');
      if (body.includes('libs/papercusp-db') && body.includes('papercusp-desktop')) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate superproject .gitmodules from ' + start);
}

interface SubmoduleEntry {
  name: string;
  path: string;
  url: string;
}

function parseGitmodules(body: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  let cur: Partial<SubmoduleEntry> | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[submodule "(.+)"\]$/.exec(line);
    if (header) {
      if (cur?.path && cur?.url) entries.push(cur as SubmoduleEntry);
      cur = { name: header[1] };
      continue;
    }
    if (!cur) continue;
    const kv = /^(path|url)\s*=\s*(.+)$/.exec(line);
    if (kv) (cur as Record<string, string>)[kv[1]] = kv[2].trim();
  }
  if (cur?.path && cur?.url) entries.push(cur as SubmoduleEntry);
  return entries;
}

describe('.gitmodules submodule URL invariants (release blocker)', () => {
  const root = findRepoRoot(process.cwd());
  const entries = parseGitmodules(readFileSync(join(root, '.gitmodules'), 'utf8'));

  it('parses the expected superproject submodule set', () => {
    // Sanity: we actually parsed the big superproject file, not a stray fixture.
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((e) => e.path)).toContain('libs/papercusp-db');
    expect(entries.map((e) => e.path)).toContain('libs/papercusp-shared');
  });

  it('references NONE of the known-dead papercusp-* rename URLs (the 2026-06-25 incident)', () => {
    // These repos do NOT exist on GitHub — the rename overreached. The real
    // repos kept their original `papercup-*` names.
    const DEAD = [/Papercusp\/papercusp-db(\.git)?$/i, /Papercusp\/papercusp-shared(\.git)?$/i];
    const offenders = entries.filter((e) => DEAD.some((re) => re.test(e.url)));
    expect(
      offenders,
      `stale submodule URL(s) point at a non-existent renamed repo → fresh clones fail setup: ` +
        offenders.map((o) => `${o.path} → ${o.url}`).join(', '),
    ).toEqual([]);
  });

  it('the load-bearing source submodules point at the real (papercup-named) repos', () => {
    const byPath = new Map(entries.map((e) => [e.path, e.url]));
    expect(byPath.get('libs/papercusp-db')).toBe('git@github.com:Papercusp/papercup-db.git');
    expect(byPath.get('libs/papercusp-shared')).toBe(
      'git@github.com:Papercusp/papercup-shared.git',
    );
  });

  // A registered foreign-hive submodule (scripts/lib/foreign-hive-submodules.mjs) is ANOTHER hive's
  // repository and keeps that hive's remote (WI-6554700010009815). Only an EXACT path + url match is
  // excused, so the registry can never widen into a blanket HTTPS exemption.
  const isRegisteredForeignHive = (e: SubmoduleEntry): boolean =>
    FOREIGN_HIVE_SUBMODULES.some((hive) => hive.path === e.path && hive.url === e.url);

  it('every submodule URL is an SSH GitHub URL under the Papercusp org', () => {
    const bad = entries.filter(
      (e) => !/^git@github\.com:Papercusp\/[\w.-]+\.git$/i.test(e.url) && !isRegisteredForeignHive(e),
    );
    expect(
      bad,
      `non-conforming submodule URL(s): ${bad.map((b) => `${b.path} → ${b.url}`).join(', ')}` +
        ' (another hive\'s submodule belongs in scripts/lib/foreign-hive-submodules.mjs)',
    ).toEqual([]);
  });

  it('declares every registered foreign hive in .gitmodules with exactly its registered url', () => {
    // The other half of the two-way pin: a registry entry whose submodule moved, changed url or was
    // removed is stale, and would otherwise keep excusing a path nobody declares.
    const byPath = new Map(entries.map((e) => [e.path, e.url]));
    const stale = FOREIGN_HIVE_SUBMODULES.filter((hive) => byPath.get(hive.path) !== hive.url);
    expect(
      stale.map((hive) => `${hive.path} → ${hive.url} (.gitmodules: ${byPath.get(hive.path) ?? 'absent'})`),
    ).toEqual([]);
    // Falsifiable: the same path under any other url is NOT excused.
    for (const hive of FOREIGN_HIVE_SUBMODULES) {
      expect(isRegisteredForeignHive({ name: hive.path, path: hive.path, url: hive.url })).toBe(true);
      expect(isRegisteredForeignHive({ name: hive.path, path: hive.path, url: `${hive.url}.other` })).toBe(false);
    }
  });
});

/**
 * Recurrence guard for EI-14414 (2026-07-17): git-sync auto-commits the superproject
 * AND every submodule on a schedule, with no per-repo opt-out and no grace period — so
 * an npm-based submodule with no `.gitignore` (or one that omits `node_modules/`) leaks
 * scratch/build artifacts into its history the moment ANYTHING creates untracked files
 * (even a one-off `npx vitest run` to sanity-check a brand-new lib), because git-sync's
 * next tick sweeps them in before anyone notices. Live case: extracting
 * `@papercusp/model-pricing` into its own submodule (WI-5143) got a stray
 * `node_modules/.vite/...results.json` auto-committed within minutes.
 *
 * This is NOT hypothetical for the CURRENT tree either — auditing every submodule
 * turned up two (`libs/papercusp-db`, `libs/generic/token-kit`) whose `.gitignore`
 * already existed (from the WI-4419 `.papercusp/` scratch-dir guard) but never picked
 * up the base `node_modules/` line other borrowable libs carry — fixed alongside this
 * test. Only submodules with a `package.json` (i.e. actually npm-managed) are checked;
 * a non-JS submodule (`libs/zero-harness`) has no `node_modules` risk to guard.
 */
describe('submodule .gitignore invariants (EI-14414 — node_modules leak into git-sync)', () => {
  const root = findRepoRoot(process.cwd());
  const entries = parseGitmodules(readFileSync(join(root, '.gitmodules'), 'utf8'));
  const npmSubmodules = entries.filter((e) => existsSync(join(root, e.path, 'package.json')));

  it('found at least one npm-managed submodule to check (sanity — not an empty pass)', () => {
    expect(npmSubmodules.length).toBeGreaterThan(10);
  });

  it('every npm-managed submodule has its OWN .gitignore that ignores node_modules/', () => {
    const offenders: string[] = [];
    for (const e of npmSubmodules) {
      const giPath = join(root, e.path, '.gitignore');
      if (!existsSync(giPath)) {
        offenders.push(`${e.path} (no .gitignore at all)`);
        continue;
      }
      const body = readFileSync(giPath, 'utf8');
      // Accept any reasonable node_modules-ignoring line (bare, leading slash, or **/-anchored).
      if (!/(^|\n)\s*(\*\*\/)?\/?node_modules\/?\s*(\n|$)/.test(body)) {
        offenders.push(`${e.path} (.gitignore exists but has no node_modules/ pattern)`);
      }
    }
    expect(
      offenders,
      `submodule(s) at risk of a git-sync auto-commit sweeping in node_modules/ the moment ` +
        `an npm install/test run creates it (see EI-14414): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
