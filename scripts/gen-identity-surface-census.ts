/**
 * gen:identity-surface-census — (re)derive the checked-in inventory of every
 * behavior-shaping surface outside the identity system
 * (identity-system-everything-migration-2026-10-18 P-001; seeds the P-005 lint).
 *
 *   npm run gen:identity-surface-census          # write the inventory (REFUSES to add a policed surface)
 *   npm run lint:identity-surfaces               # = ... --check (P-005, R-16):
 *                                                #   exit 1 on a NEW surface outside the identity system,
 *                                                #   a ceiling breach, or a stale inventory.
 *                                                #   ONE script name on purpose: lint:guard-reachability
 *                                                #   does not credit an impl path two guards share.
 *   ... --check --baseline <file>                # lint against another baseline (a seeded copy)
 *
 * The inventory is DERIVED (packages/operator-core/lib/agent-identities/identity-surface-census.ts);
 * never edit the generated JSON by hand. `identity-surface-census.test.ts` refuses drift.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IDENTITY_SURFACE_CENSUS_GENERATOR,
  IDENTITY_SURFACE_CENSUS_REL,
  defaultCensusRoot,
  deriveIdentitySurfaceCensus,
  renderIdentitySurfaceCensus,
  type IdentitySurfaceCensus,
} from '../packages/operator-core/lib/agent-identities/identity-surface-census';
import { planIdentitySurfaceInventoryWrite, runIdentitySurfaceCheck } from '../packages/operator-core/lib/agent-identities/identity-surface-lint';

const root = defaultCensusRoot();
const target = join(root, IDENTITY_SURFACE_CENSUS_REL);
const census = deriveIdentitySurfaceCensus(root);
const rendered = renderIdentitySurfaceCensus(census);

// `--baseline <path>` lints against another file (a seeded copy); the default is the checked-in inventory.
const baselineFlag = process.argv.indexOf('--baseline');
const baselinePath = baselineFlag >= 0 ? process.argv[baselineFlag + 1] : target;
const readBaseline = (): { text: string; census: IdentitySurfaceCensus } | null => {
  if (!baselinePath || !existsSync(baselinePath)) return null;
  const text = readFileSync(baselinePath, 'utf8');
  return { text, census: JSON.parse(text) as IdentitySurfaceCensus };
};

if (process.argv.includes('--check')) {
  const baseline = readBaseline();
  if (!baseline) {
    console.error(`IDENTITY_SURFACE_CENSUS drift: ${baselinePath} is missing — run: ${IDENTITY_SURFACE_CENSUS_GENERATOR}`);
    process.exit(1);
  }
  const outcome = runIdentitySurfaceCheck(baseline.census, census);
  // Same entries but different bytes (counts / metadata) is drift too.
  if (outcome.exitCode === 0 && baseline.text !== rendered) {
    console.error(`IDENTITY_SURFACE_CENSUS drift (metadata) — run: ${IDENTITY_SURFACE_CENSUS_GENERATOR}`);
    process.exit(1);
  }
  const [head, ...rest] = outcome.lines;
  (outcome.exitCode === 0 ? console.log : console.error)(head);
  for (const l of rest) console.error(`  ${l}`);
  process.exit(outcome.exitCode);
}

// The inventory's only writer refuses to grow it (R-16): a new policed surface is refused, not recorded.
const plan = planIdentitySurfaceInventoryWrite(readBaseline()?.census ?? null, census);
if (!plan.ok) {
  console.error(`refusing to write ${IDENTITY_SURFACE_CENSUS_REL}: the baseline is shrink-only (identity-system-everything-migration-2026-10-18 R-16)`);
  for (const l of plan.lines) console.error(`  ${l}`);
  process.exit(1);
}
writeFileSync(target, rendered);
console.log(
  `wrote ${IDENTITY_SURFACE_CENSUS_REL}: ${census.entries.length} surfaces ${JSON.stringify(census.counts)} hooks ${JSON.stringify(census.hookKinds)}` +
    ` (moved ${plan.moved}, retired ${plan.retired})`,
);
