/** D-018: outcome instruments, independent of whether their regression tests pass.
 * R-6 measures the entire requested population, including packages not yet written.
 * R-7 checks package-owned claims. Live attestation/report review remains ledger-owned:
 * a tree-only reader never upgrades a README citation into a verified live run.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { moduleRepoRoot } from '../module-repo-root';

export const PROVIDER_PACKAGE_PLAN = 'provider-adapters-to-packages-2026-10-11';
export const PROVIDER_PACKAGE_INSTRUMENT_KEYS = {
  additions: 'providers:requested-additions',
  claims: 'providers:verification-claims',
} as const;

type ObjectValue = Record<string, any>;
const object = (value: unknown): value is ObjectValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export interface ProviderPackageInput {
  path: string;
  manifest: ObjectValue;
  readme: string | null;
  entryPresent: boolean;
  sha256: string;
}
export interface PackageFinding { package: string; reason: string }
export interface PackageMeasurement {
  verdict: 'pass' | 'fail' | 'unknown';
  population: string[];
  checked: string[];
  failures: PackageFinding[];
  unknown: PackageFinding[];
  evidence: Array<{ path: string; sha256: string }>;
  scope: string;
}

const ADDITIONS = [
  { label: 'LinkedIn company page', ids: ['linkedin-company', 'linkedin'], matches: (p: ObjectValue) =>
    strings(p.capabilities).includes('social.post') && strings(p.oauth?.scopes).includes('w_organization_social') &&
    object(p.configSchema?.properties?.organizationId) },
  { label: 'X', ids: ['x-twitter'], matches: (p: ObjectValue) => strings(p.capabilities).includes('social.post') },
  { label: 'dev.to', ids: ['devto', 'dev-to'], matches: (p: ObjectValue) => strings(p.capabilities).length > 0 },
  { label: 'Hashnode', ids: ['hashnode'], matches: (p: ObjectValue) => strings(p.capabilities).length > 0 },
  { label: 'Discord community bot', ids: ['discord'], matches: (p: ObjectValue) => strings(p.capabilities).length > 0 && p.sync !== false },
] as const;

/** A manifest/directory placeholder is not a package. Load/install behavior is R-1. */
export function measureRequestedProviderAdditions(packages: readonly ProviderPackageInput[]): PackageMeasurement {
  const failures: PackageFinding[] = [], checked: string[] = [];
  for (const addition of ADDITIONS) {
    const candidates = packages.filter(p => addition.ids.some(id => id === p.manifest.provider?.id));
    const matching = candidates.filter(p => p.manifest.kind === 'plugin' && p.entryPresent &&
      p.manifest.provider?.contractVersion === 1 && addition.matches(p.manifest.provider));
    if (matching.length === 1) checked.push(addition.label);
    else failures.push({ package: addition.label, reason: matching.length > 1 ? 'Ambiguous duplicate provider packages.' :
      candidates.length ? 'A package exists but does not provide the requested addition (or its executable entry is absent).' : 'No provider package.' });
  }
  return { verdict: failures.length ? 'fail' : 'pass', population: ADDITIONS.map(a => a.label), checked, failures, unknown: [],
    evidence: packages.map(p => ({ path: p.path, sha256: p.sha256 })),
    scope: 'Current package presence and requested descriptor shape; not installation, vendor approval or live-account acceptance.' };
}

/** Suppress only negative clauses, not the remainder of a paragraph. An appended
 * "Live-verified" must still fail beside an earlier "live verification pending".
 */
function positiveLiveClaim(text: string): boolean {
  const plain = text.replace(/[*_`]/g, '');
  const withoutNegatives = plain.replace(/\b(?:no|not|never|without)\b[^.!?\n;]{0,100}\blive(?:[- ]account)?(?:[- ]verification|[- ]verified)?[^.!?\n;]*/gi, '')
    .replace(/\blive(?:[- ]account)?[- ]verification\s+(?:is\s+)?pending\b/gi, '')
    .replace(/\b(?:fixture|fake|offline)[^.!?\n;]{0,100}(?:do(?:es)? not|cannot|never)[^.!?\n;]{0,100}\blive[^.!?\n;]*/gi, '');
  return /\blive[- ]verified\b|\bverified\s+live\b|\blive(?:[- ]account)?[- ]verification\b/i.test(withoutNegatives);
}

/** D-002 keeps the member package self-serve and the separate company package
 * approval-blocked. Contract dates do not establish a real partner grant.
 */
export function measureProviderVerificationClaims(packages: readonly ProviderPackageInput[]): PackageMeasurement {
  const failures: PackageFinding[] = [], unknown: PackageFinding[] = [], checked: string[] = [];
  for (const pkg of packages) {
    const p = pkg.manifest.provider;
    if (!object(p)) continue;
    const id = typeof p.id === 'string' ? p.id : pkg.path;
    const before = failures.length + unknown.length;
    const text = `${pkg.manifest.description ?? ''}\n${pkg.readme ?? ''}`;
    if (positiveLiveClaim(text) || ['live', 'live-verified'].includes(p.verification?.level) ||
        ['live', 'live-verified'].includes(p.verification?.mode)) failures.push({ package: id, reason: 'Live verification claimed without an independently resolved live-run attestation. Tree citations and contract-review dates are not live runs.' });
    if (!pkg.readme || !/\b(?:fake|fakes|fixture|fixtures|offline)\b/i.test(pkg.readme) || !/\b(?:conformance|SDK kit)\b/i.test(pkg.readme) ||
        !/\b(?:pending|no live|not live|no live-account|not been performed)\b/i.test(pkg.readme)) {
      unknown.push({ package: id, reason: 'README must explicitly identify offline/fake plus conformance verification and the pending live run.' });
    }
    const capabilities = strings(p.capabilities);
    for (const capability of capabilities) {
      if (!object(p.verification?.capabilities) || !p.verification.capabilities[capability]) {
        failures.push({ package: id, reason: `Capability ${capability} has no package-owned contract verification.` });
      }
      if (p.verification?.blockedOn?.[capability]) failures.push({ package: id, reason: `Capability ${capability} is declared despite its approval blocker.` });
    }
    if (id === 'linkedin' && (capabilities.some(c => !['social.post', 'social.delete'].includes(c)) || p.sync !== false ||
        strings(p.oauth?.scopes).some(scope => !['openid', 'profile', 'w_member_social'].includes(scope)) ||
        object(p.configSchema?.properties?.organizationId))) {
      failures.push({ package: id, reason: 'LinkedIn claims exceed the self-serve member grant; organization/community approval is not evidenced (D-002).' });
    }
    if (id === 'linkedin-company' && (typeof p.verification?.blockedOn !== 'string' || !p.verification.blockedOn.trim())) {
      failures.push({ package: id, reason: 'LinkedIn company access must remain approval-blocked until independent partner-grant and data-flow review (D-002).' });
    }
    if (id === 'linkedin-company' && (p.oauth?.clientRegistrationRef !== 'linkedin-company' ||
        !['openid', 'profile', 'r_organization_social', 'w_organization_social'].every(scope => strings(p.oauth?.scopes).includes(scope)) ||
        p.oauth?.identity?.url !== 'https://api.linkedin.com/v2/userinfo' || p.oauth?.identity?.idField !== 'sub' ||
        !object(p.configSchema?.properties?.organizationId))) {
      failures.push({ package: id, reason: 'LinkedIn company identity, Page resource or independent registration is missing; the personal member grant cannot stand in for it.' });
    }
    if (before === failures.length + unknown.length) checked.push(id);
  }
  if (!packages.length) unknown.push({ package: '*', reason: 'No provider packages were measured.' });
  return { verdict: failures.length ? 'fail' : unknown.length ? 'unknown' : 'pass', population: packages.map(p => p.manifest.provider?.id ?? p.path),
    checked, failures, unknown, evidence: packages.map(p => ({ path: p.path, sha256: p.sha256 })),
    scope: 'Current package README/manifest offline claims and declared contract/LinkedIn approval boundary. Completion reports, actual account grants and live attestations still require independent ledger review.' };
}

/** Read the serving checkout, never an environment-selected sibling or cached fixture list. */
export async function measureProviderPackageAcceptance(root = moduleRepoRoot(import.meta.url)) {
  const directory = join(root, 'libs/papercusp/plugins');
  const packages: ProviderPackageInput[] = [];
  const errors: PackageFinding[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = `libs/papercusp/plugins/${entry.name}/papercusp.json`;
    let bytes: string;
    try { bytes = await readFile(join(root, path), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    try {
      const manifest = JSON.parse(bytes);
      if (!object(manifest.provider)) continue;
      // R-7 covers all delivered social packages and the non-social named additions.
      if (!strings(manifest.provider.datatypes).includes('social-post') &&
          !ADDITIONS.some(a => a.ids.some(id => id === manifest.provider.id))) continue;
      const packageRoot = await realpath(join(directory, entry.name));
      let entryPresent = false;
      if (typeof manifest.main === 'string' && !isAbsolute(manifest.main)) {
        try {
          const target = await realpath(resolve(packageRoot, manifest.main));
          const rel = relative(packageRoot, target);
          entryPresent = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && (await stat(target)).isFile();
        } catch { /* Missing/unreadable entry is a measured absence, not a valid package. */ }
      }
      let readme: string | null = null;
      try { readme = await readFile(join(packageRoot, 'README.md'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      packages.push({ path, manifest, readme, entryPresent,
        sha256: createHash('sha256').update(bytes).update('\0').update(readme ?? '').update(`\0entryPresent:${entryPresent}`).digest('hex') });
    } catch (error) { errors.push({ package: path, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const additions = measureRequestedProviderAdditions(packages), claims = measureProviderVerificationClaims(packages);
  for (const result of [additions, claims]) {
    result.unknown.push(...errors);
    if (errors.length && result.verdict === 'pass') result.verdict = 'unknown';
  }
  return { root, additions, claims };
}
