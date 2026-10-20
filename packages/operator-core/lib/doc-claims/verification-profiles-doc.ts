/**
 * R-20 (plan-verification-profiles-2026-10-17 P-008): pin the verification-profiles guide to
 * the resolver it describes.
 *
 * The guide (agent-insights/plan-verification-profiles) carries three Markdown tables, found
 * by their header rows:
 *
 *   | Module | Checks it owns |                                  module -> check families
 *   | Profile | Default deliverable | Modules an undeclared item gets |
 *   | Deliverable | Modules |                                    declared deliverable -> modules
 *
 * `judgeVerificationProfilesDoc` compares each table with facts DERIVED from the resolver
 * (`liveVerificationProfileFacts`), in both directions: a row the resolver does not have is a
 * divergence, and so is a resolver entry the page leaves out. Cells are read as the set of
 * backtick-quoted tokens they contain, so prose around the tokens is free to change.
 *
 * The judge is pure so the test can feed it a diverged page (it must say NO) and a correct
 * synthetic page (it must still say YES), the control/calibration pair the sibling
 * doc-claims judges use.
 */
import {
  DELIVERABLE_KINDS,
  VERIFICATION_PROFILES,
  type DeliverableKind,
  type VerificationProfile,
} from '@papercusp/plan-parser';
import {
  VERIFICATION_MODULES,
  VERIFICATION_MODULE_CHECKS,
  resolveVerification,
} from '../plan-verification-profile';

export interface VerificationProfileFacts {
  /** module -> the check families it owns, in resolver order. */
  moduleChecks: ReadonlyMap<string, readonly string[]>;
  /** profile -> the deliverable and modules an item that declares nothing resolves to. */
  profileDefaults: ReadonlyMap<string, { deliverable: string; modules: readonly string[] }>;
  /** declared deliverable -> the modules it resolves to (identical under every profile). */
  deliverableModules: ReadonlyMap<string, readonly string[]>;
}

/** Ask the resolver itself, so the facts cannot drift from what the gates read. */
export function liveVerificationProfileFacts(): VerificationProfileFacts {
  const moduleChecks = new Map<string, readonly string[]>();
  for (const module of VERIFICATION_MODULES) moduleChecks.set(module, VERIFICATION_MODULE_CHECKS[module]);

  const profileDefaults = new Map<string, { deliverable: string; modules: readonly string[] }>();
  for (const profile of VERIFICATION_PROFILES as readonly VerificationProfile[]) {
    const resolved = resolveVerification({ verificationProfile: profile }, {});
    if (resolved.deliverable === null) throw new Error(`profile '${profile}' resolves no default deliverable`);
    profileDefaults.set(profile, { deliverable: resolved.deliverable, modules: resolved.modules });
  }

  const deliverableModules = new Map<string, readonly string[]>();
  for (const kind of DELIVERABLE_KINDS as readonly DeliverableKind[]) {
    const perProfile = (VERIFICATION_PROFILES as readonly VerificationProfile[]).map(
      (profile) => resolveVerification({ verificationProfile: profile }, { deliverable: kind }).modules,
    );
    const first = perProfile[0] ?? [];
    if (perProfile.some((modules) => modules.join(',') !== first.join(','))) {
      // The guide states a declared deliverable wins over the profile. If that stops being
      // true the page's single deliverable table is wrong by construction.
      throw new Error(`deliverable '${kind}' resolves different modules under different profiles`);
    }
    deliverableModules.set(kind, first);
  }
  return { moduleChecks, profileDefaults, deliverableModules };
}

export const MODULE_TABLE_HEADER = ['Module', 'Checks it owns'] as const;
export const PROFILE_TABLE_HEADER = ['Profile', 'Default deliverable', 'Modules an undeclared item gets'] as const;
export const DELIVERABLE_TABLE_HEADER = ['Deliverable', 'Modules'] as const;

/** Body rows of the first Markdown table whose header cells equal `header`; null = no such table. */
export function readMarkdownTable(doc: string, header: readonly string[]): string[][] | null {
  const lines = doc.split('\n');
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('|')) continue;
    const head = cells(line);
    if (head.length !== header.length || head.some((cell, j) => cell !== header[j])) continue;
    const rows: string[][] = [];
    for (let k = i + 2; k < lines.length; k++) {
      const row = lines[k]!.trim();
      if (!row.startsWith('|')) break;
      rows.push(cells(row));
    }
    return rows;
  }
  return null;
}

/** The backtick-quoted tokens in a cell, in order. */
export function codeTokens(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/** Every way the page disagrees with the resolver. Empty = in sync. */
export function judgeVerificationProfilesDoc(doc: string, facts: VerificationProfileFacts): string[] {
  const problems: string[] = [];

  const keyed = (header: readonly string[], label: string): Map<string, string[]> | null => {
    const rows = readMarkdownTable(doc, header);
    if (rows === null) {
      problems.push(`missing the ${label} table (header | ${header.join(' | ')} |)`);
      return null;
    }
    const byKey = new Map<string, string[]>();
    for (const row of rows) {
      const key = codeTokens(row[0] ?? '');
      if (key.length !== 1) {
        problems.push(`${label} table row '${row.join(' | ')}' must name exactly one \`key\` in its first cell`);
        continue;
      }
      if (byKey.has(key[0]!)) problems.push(`${label} table lists '${key[0]}' twice`);
      byKey.set(key[0]!, row);
    }
    return byKey;
  };

  const modules = keyed(MODULE_TABLE_HEADER, 'module');
  if (modules) {
    for (const [module, checks] of facts.moduleChecks) {
      const row = modules.get(module);
      if (!row) {
        problems.push(`module '${module}' is in the resolver but not in the module table`);
        continue;
      }
      const documented = codeTokens(row[1] ?? '');
      if (!sameSet(documented, checks)) {
        problems.push(`module '${module}' documents checks [${documented.join(', ')}]; the resolver has [${checks.join(', ')}]`);
      }
    }
    for (const module of modules.keys()) {
      if (!facts.moduleChecks.has(module)) problems.push(`module table lists '${module}', which the resolver does not have`);
    }
  }

  const profiles = keyed(PROFILE_TABLE_HEADER, 'profile');
  if (profiles) {
    for (const [profile, expected] of facts.profileDefaults) {
      const row = profiles.get(profile);
      if (!row) {
        problems.push(`profile '${profile}' is in the resolver but not in the profile table`);
        continue;
      }
      const deliverable = codeTokens(row[1] ?? '');
      if (deliverable.length !== 1 || deliverable[0] !== expected.deliverable) {
        problems.push(`profile '${profile}' documents default deliverable [${deliverable.join(', ')}]; the resolver has '${expected.deliverable}'`);
      }
      const documented = codeTokens(row[2] ?? '');
      if (!sameSet(documented, expected.modules)) {
        problems.push(`profile '${profile}' documents modules [${documented.join(', ')}]; the resolver has [${expected.modules.join(', ')}]`);
      }
    }
    for (const profile of profiles.keys()) {
      if (!facts.profileDefaults.has(profile)) problems.push(`profile table lists '${profile}', which the resolver does not have`);
    }
  }

  const deliverables = keyed(DELIVERABLE_TABLE_HEADER, 'deliverable');
  if (deliverables) {
    for (const [kind, expected] of facts.deliverableModules) {
      const row = deliverables.get(kind);
      if (!row) {
        problems.push(`deliverable '${kind}' is in the resolver but not in the deliverable table`);
        continue;
      }
      const documented = codeTokens(row[1] ?? '');
      if (!sameSet(documented, expected)) {
        problems.push(`deliverable '${kind}' documents modules [${documented.join(', ')}]; the resolver has [${expected.join(', ')}]`);
      }
    }
    for (const kind of deliverables.keys()) {
      if (!facts.deliverableModules.has(kind)) problems.push(`deliverable table lists '${kind}', which the resolver does not have`);
    }
  }

  return problems;
}
