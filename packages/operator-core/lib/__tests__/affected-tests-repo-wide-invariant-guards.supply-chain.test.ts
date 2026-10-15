/**
 * affected-tests-repo-wide-invariant-guards.supply-chain.test.ts — supply-chain gates (reachable advisory, rust advisory, lockfile census / SBOM).
 *
 * One shard of the affected-tests-repo-wide-invariant-guards*.test.ts family (split by
 * green-main-cycle-time-2026-10-08 P-004 so the gate can run the shards in
 * parallel). The suite's rationale, probe helpers and fixture constants live in
 * ./affected-tests-repo-wide-invariant-guards.shared.ts — read its header before adding a section here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  printAffected,
} from './affected-tests-repo-wide-invariant-guards.shared';


/**
 * WI-2144851 / P-007 — the reachable-production-advisory gate, wired the same way.
 *
 * `scripts/check-reachable-advisories.mjs` attributes every npm advisory to the workspace(s)
 * that pull it in and gates only on the SHIPPING high/critical set. Its subject is not any
 * workspace's source — it is the dependency GRAPH — so workspace selection cannot reach it:
 * a new shipping advisory enters through a manifest/lockfile edit in a workspace whose own
 * suite has no reason to run a dependency audit. Before this registration the gate existed,
 * was falsifiable, and ran on NO path at all.
 *
 * The pair below is what makes the registration falsifiable rather than merely present:
 * a predicate that stopped matching manifests, and one that widened to all source, are both
 * silent failures in opposite directions — the first turns the gate off, the second bills
 * every source edit ~15s of `npm audit`. Only asserting BOTH catches either.
 *
 * The third case covers the silent-no-op shape the whole file exists for
 * (`if (!ws?.scripts?.[guard.script]) continue`): drop the script from operator-core's
 * package.json and the registration above stays, looks correct, and attaches nothing.
 */
describe('affected-tests: reachable-advisory gate (WI-2144851)', () => {
  const ADVISORY_SCRIPT = 'lint:reachable-advisories';
  const ADVISORY_GUARD_PREFIX = `AFFECTED_GUARD\t@papercusp/operator-core\t${ADVISORY_SCRIPT}\t`;

  it('attaches for a dependency-manifest change in another workspace', () => {
    const out = printAffected('packages/operator-core/package.json');
    const guardLine = out
      .split('\n')
      .filter(Boolean)
      .find((line) => line.startsWith(ADVISORY_GUARD_PREFIX));
    expect(guardLine).toBe(
      `${ADVISORY_GUARD_PREFIX}npm run --silent --workspace @papercusp/operator-core ${ADVISORY_SCRIPT}`,
    );
  });

  it('does NOT attach for an ordinary source change (a source edit cannot add an advisory)', () => {
    const out = printAffected('packages/operator-core/lib/tsc-diagnostics.ts');
    expect(out).not.toContain(ADVISORY_GUARD_PREFIX);
  });

  it('keeps the guard script declared on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[ADVISORY_SCRIPT]).toContain('check-reachable-advisories.mjs');
    // --strict is what makes it GATE rather than report; without it the guard exits 0 on a
    // brand-new shipping high advisory and the whole registration is decoration.
    expect(pkg.scripts?.[ADVISORY_SCRIPT]).toContain('--strict');
  });
});

/**
 * WI-2144851 / P-007 — the RUST half of the same advisory clause, wired the same way.
 *
 * The gate above is npm-only by construction; `scripts/check-rust-advisories.mjs` covers
 * the 615 crates that papercusp-desktop/src-tauri/Cargo.lock pins into the SHIPPED desktop
 * app. Workspace selection can never reach that subject: papercusp-desktop is a SUBMODULE
 * and is deliberately absent from the root npm workspaces, so no workspace suite runs on a
 * Cargo.lock edit.
 *
 * The third case is not ceremony — it is the failure this registration ACTUALLY hit during
 * development. The npm script was added to the ROOT package.json only, so
 * `if (!ws?.scripts?.[guard.script]) continue` skipped the entry SILENTLY: the registry
 * entry was present and correct-looking, the negative controls still "passed" (a guard that
 * never attaches never over-attaches), and the gate ran on no path at all. A green negative
 * control cannot distinguish a correctly-scoped guard from an absent one; only the positive
 * cases below can.
 */
describe('affected-tests: rust advisory gate (WI-2144851)', () => {
  const RUST_SCRIPT = 'lint:rust-advisories';
  const RUST_GUARD_PREFIX = `AFFECTED_GUARD\t@papercusp/operator-core\t${RUST_SCRIPT}\t`;

  it('attaches for a change to the SHIPPED Cargo.lock', () => {
    const out = printAffected('papercusp-desktop/src-tauri/Cargo.lock');
    const guardLine = out
      .split('\n')
      .filter(Boolean)
      .find((line) => line.startsWith(RUST_GUARD_PREFIX));
    expect(guardLine).toBe(
      `${RUST_GUARD_PREFIX}npm run --silent --workspace @papercusp/operator-core ${RUST_SCRIPT}`,
    );
  });

  it('attaches for a change to its own baseline (the shrink-only file)', () => {
    expect(printAffected('scripts/rust-advisories-baseline.json')).toContain(RUST_GUARD_PREFIX);
  });

  it('does NOT attach for an ordinary source change', () => {
    expect(printAffected('packages/operator-core/lib/tsc-diagnostics.ts')).not.toContain(RUST_GUARD_PREFIX);
  });

  it('does NOT attach for a Cargo.lock that does not ship', () => {
    // Six of the seven Cargo.lock files here are dev/vendored surfaces. Widening the
    // predicate to all of them bills every vendored-crate edit a network advisory scan
    // for a graph that never reaches a user.
    expect(printAffected('apps/tui/Cargo.lock')).not.toContain(RUST_GUARD_PREFIX);
  });

  it('keeps the guard script declared on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[RUST_SCRIPT]).toContain('check-rust-advisories.mjs');
    // Without --strict the guard exits 0 on a brand-new shipped Rust vulnerability and the
    // whole registration is decoration.
    expect(pkg.scripts?.[RUST_SCRIPT]).toContain('--strict');
  });
});

/**
 * WI-2144851 / P-007 — the SBOM/INVENTORY half of the same audit clause.
 *
 * The two advisory gates above each scan ONE hand-chosen lockfile. Neither can see a
 * dependency graph outside its own scope, and a graph nobody scans is not reported clean —
 * it is not measured, which reads identically from outside. `scripts/check-lockfile-census.mjs`
 * derives the whole lockfile population from the filesystem and forces every row into an
 * explicit bucket, so a new blind spot fails instead of waiting to be found by hand.
 *
 * TRIGGER SCOPE is the WIDEST of the three on purpose, and that is the point of the first
 * case: the event that matters is a lockfile APPEARING at a path that does not exist yet,
 * which no narrower matcher can enumerate in advance. Both blind spots that motivated the
 * file entered exactly that way.
 */
describe('affected-tests: lockfile census / SBOM gate (WI-2144851)', () => {
  const CENSUS_SCRIPT = 'lint:lockfile-census';
  const CENSUS_GUARD_PREFIX = `AFFECTED_GUARD\t@papercusp/operator-core\t${CENSUS_SCRIPT}\t`;

  it('attaches for a lockfile at a path that does not exist yet', () => {
    const out = printAffected('some/newly/added/package/package-lock.json');
    const guardLine = out
      .split('\n')
      .filter(Boolean)
      .find((line) => line.startsWith(CENSUS_GUARD_PREFIX));
    expect(guardLine).toBe(
      `${CENSUS_GUARD_PREFIX}npm run --silent --workspace @papercusp/operator-core ${CENSUS_SCRIPT}`,
    );
  });

  it('attaches for a new Cargo.lock anywhere in the tree', () => {
    // Deliberately WIDER than the Rust advisory gate, which fires only on the shipped
    // lockfile. Coverage of a graph and the SHIPPING of that graph are different
    // questions, and the census is the one that must see every candidate.
    expect(printAffected('some/rust/crate/Cargo.lock')).toContain(CENSUS_GUARD_PREFIX);
    expect(printAffected('apps/tui/Cargo.lock')).toContain(CENSUS_GUARD_PREFIX);
  });

  it('attaches for a change to the census script itself', () => {
    expect(printAffected('scripts/check-lockfile-census.mjs')).toContain(CENSUS_GUARD_PREFIX);
  });

  it('does NOT attach for an ordinary source change', () => {
    expect(printAffected('packages/operator-core/lib/tsc-diagnostics.ts')).not.toContain(CENSUS_GUARD_PREFIX);
  });

  it('does NOT attach for a lockfile inside node_modules', () => {
    // Vendored lockfiles under node_modules are not this repo's dependency graph, and the
    // walker prunes them; billing a census run for one would be pure noise.
    expect(printAffected('node_modules/some-dep/package-lock.json')).not.toContain(CENSUS_GUARD_PREFIX);
  });

  // The case that is not ceremony: this exact omission silently unattached the Rust guard
  // during its own development. `if (!ws?.scripts?.[guard.script]) continue` skips an entry
  // whose script is missing from the HOST workspace's package.json, with no message. The
  // registry entry looks right, the negative controls still pass — a guard that never
  // attaches also never over-attaches — and the gate runs on no path at all.
  it('keeps the guard script declared on the host workspace, with --strict', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[CENSUS_SCRIPT]).toContain('check-lockfile-census.mjs');
    // Without --strict an UNCLASSIFIED lockfile exits 0 and the registration is decoration.
    expect(pkg.scripts?.[CENSUS_SCRIPT]).toContain('--strict');
  });

  // syft is a dev-box binary, not a pipeline dependency, and emitSbom REFUSES when it is
  // absent rather than skipping quietly. That refusal is correct for an on-demand
  // inventory and would red-pin every host without syft if it sat on the gate path.
  it('keeps SBOM emission OFF the gate path and on its own root entrypoint', () => {
    const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const corePkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(corePkg.scripts?.[CENSUS_SCRIPT]).not.toContain('--sbom');
    expect(rootPkg.scripts?.['lint:lockfile-census:sbom']).toContain('--sbom');

    // `toContain('--sbom')` above is TRUE of a script that emits nothing, and that is not
    // hypothetical: this entrypoint read `--strict --sbom` — flag last, no operand — from
    // the day it was written until 2026-09-05. `--sbom` takes a PATH, so the emit block
    // never ran; the script printed the plain census and exited 0. The assertion one line
    // up passed the whole time, because the flag WAS present. It was measuring the wrong
    // property of the right string.
    //
    // So assert the operand, not the flag. The full parse contract (bare flag and
    // flag-shaped operand both refuse) is pinned in lockfile-census-guard.test.ts against
    // the script's own parser; this keeps the registry-side assertion from going vacuous.
    const sbomArgv = String(rootPkg.scripts?.['lint:lockfile-census:sbom']).split(/\s+/);
    const operand = sbomArgv[sbomArgv.indexOf('--sbom') + 1];
    expect(operand, '--sbom is the last token: the SBOM would be silently skipped').toBeTypeOf('string');
    expect(operand?.startsWith('-'), `--sbom operand is the flag \`${operand}\`, not a path`).toBe(false);
  });
});
