/**
 * Provider-specific code census: the detection rules and the census itself, over an
 * abstract file list (plan cupboard-distributable-integrations-2026-10-10, P-015; WI-6554700010018633).
 *
 * The shrink-only test (provider-specific-census.test.ts) walks the working tree and asserts
 * over this census. The spec-evidence evaluator re-runs the SAME census over the files
 * committed at a measurement commit (tree instrument `provider-specific-census`, see
 * agent-tools/plans/tree-instruments.ts), so a binding of that test goes stale exactly when
 * the census output changes: a planted provider module anywhere under APP_ROOTS changes it,
 * an unrelated commit does not. Keeping one implementation here is what makes the
 * evaluator's digest describe what the test actually asserts.
 *
 * Nothing in this module reads the filesystem or git: callers supply the file list and a
 * per-file content verdict.
 */

/** App-code roots. Provider packages (libs/papercusp/plugins) are the destination, not app code. */
export const APP_ROOTS = [
  'apps/operator',
  'packages/operator-core',
  'packages/agent-mcp',
  'papercusp-desktop/src',
  'orchestrator',
  'bin',
] as const;

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.next',
  'coverage',
  '.vitest-tmp',
  'sidecar',
  'e2e',
  '__tests__',
  'prompts',
  'target',
]);

export const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
export const TEST_FILE = /\.(test|spec|integration\.test)\.(ts|tsx|mts|js|mjs)$|\.fixture\.ts$/;

/**
 * A directory or file name the census never descends into or lists. dist-* holds esbuild
 * bundles (dist-devhost, dist-sidecar, ...): built copies, not source.
 */
export function isSkippedCensusName(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.') || /^dist-/.test(name);
}

/** A file name the census lists: a source extension and not a test or fixture. */
export function isCensusSourceName(name: string): boolean {
  return SOURCE_EXT.test(name) && !TEST_FILE.test(name);
}

/**
 * Whether a repo-relative POSIX path is a file the census lists: under an APP_ROOT, no
 * skipped name below that root, and a census source name. Equivalent to the working-tree
 * walk, which prunes skipped names at every level below the root.
 */
export function isCensusSourcePath(path: string): boolean {
  const root = APP_ROOTS.find((r) => path.startsWith(`${r}/`));
  if (!root) return false;
  const below = path.slice(root.length + 1).split('/');
  if (below.some((name) => name === '' || isSkippedCensusName(name))) return false;
  return isCensusSourceName(below[below.length - 1]!);
}

/** Provider names whose appearance as a path word marks a module provider-specific. */
export const PROVIDER_TOKENS = [
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'bluesky',
  'mastodon',
  'reddit',
  'facebook',
  'instagram',
  'threads',
  'tiktok',
  'youtube',
  'linkedin',
  'twitter',
  'social',
  'google',
  'gmail',
  'gcal',
  'asana',
  'linear',
  'jira',
  'notion',
] as const;

/**
 * Provider tokens deliberately NOT counted, each with its reason. `github` is excluded because
 * GitHub in app code is the platform's own source-hosting identity (repo import, user profile,
 * PAT), not an integration; GitHub as a ticket provider already ships as a package (P-010).
 */
export const EXCLUDED_TOKENS: Readonly<Record<string, string>> = {
  github: 'platform source-hosting identity, not an integration provider',
};

/** Split a repo-relative path into lower-case words (dirs, kebab, snake, camelCase). */
export function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Provider tokens named by a path, excluding EXCLUDED_TOKENS. */
export function providerWordsIn(path: string): string[] {
  const tokens = new Set<string>(PROVIDER_TOKENS);
  return [...new Set(pathWords(path).filter((w) => tokens.has(w) && !(w in EXCLUDED_TOKENS)))];
}

/**
 * Paths that contain a provider word but are not provider-specific, each with its reason.
 * Keep this short; a provider module does not belong here.
 */
export const SOCIAL_DOMAIN_SEAMS = [
  'packages/operator-core/lib/agent-tools/social/delete.ts',
  'packages/operator-core/lib/agent-tools/social/post.ts',
  'packages/operator-core/lib/agent-tools/social/read.ts',
  'packages/operator-core/lib/agent-tools/social/reply.ts',
  'packages/operator-core/lib/agent-tools/social/search.ts',
  'packages/operator-core/lib/capability-verbs/social-delete.ts',
  'packages/operator-core/lib/capability-verbs/social-read.ts',
  'packages/operator-core/lib/capability-verbs/social.ts',
] as const;
export const NOT_PROVIDER_SPECIFIC: Readonly<Record<string, string>> = Object.fromEntries(SOCIAL_DOMAIN_SEAMS.map((path) => [
  path, 'Provider-neutral social datatype/authorization/dispatch seam; installed descriptors own vendor selectors, coordinates, capabilities and HTTP. Guarded by the no-social-census test.',
]));

/** The census files whose path names a provider, sorted. */
export function providerSpecificPathsIn(files: Iterable<string>): string[] {
  return [...files].filter((f) => providerWordsIn(f).length > 0 && !(f in NOT_PROVIDER_SPECIFIC)).sort();
}

/** Integrations that must leave app code entirely (R-3): no census entry, no allowance. */
export type StrictKind = 'slack' | 'asana' | 'bug-workflow';

/**
 * Protocol markers per strict kind. Each must match the kind's real package (asserted in the
 * census test) and nothing in app code outside NOT_STRICT_SPECIFIC. Web API method names
 * count only as quoted strings, so `deps.conversations.list(...)` or `reviews.push(...)`
 * never match.
 */
export const STRICT_CONTENT_MARKERS: Readonly<Record<StrictKind, RegExp>> = {
  slack: new RegExp(
    [
      String.raw`\bslack\.com\b`,
      String.raw`\bxox[abpr]-`,
      String.raw`\bxapp-\d`,
      String.raw`@slack\/`,
      String.raw`x-slack-(?:signature|request-timestamp)`,
      String.raw`['"\x60\/](?:apps\.connections\.open|chat\.(?:postMessage|postEphemeral|update)|conversations\.(?:history|replies|members|list|info|join)|views\.(?:open|publish|update|push)|reactions\.(?:add|get|remove))['"\x60?]`,
      String.raw`['"](?:url_verification|event_callback|block_actions|view_submission|message_action)['"]`,
    ].join('|'),
    'i',
  ),
  asana: new RegExp(
    [
      String.raw`\basana\.com\b`,
      String.raw`\bopt_fields\b`,
      String.raw`\bresource_subtype\b`,
      String.raw`(?:from\s+|require\(\s*)['"]asana['"]`,
    ].join('|'),
    'i',
  ),
  'bug-workflow': new RegExp(
    [
      String.raw`\breport[-_]bug\b`,
      String.raw`:bug:`,
      String.raw`\bchat_bug_suggestions\b`,
      String.raw`\b(?:is)?[Bb]ug_?[Rr]eport(?:s|ing)?\b`,
      String.raw`\b(?:reportBug|chatBug|bugTriage|bug_triage|bugSuggest|bug_suggest)`,
    ].join('|'),
  ),
};

const BUG_PATH_WORDS = new Set(['bug', 'bugs']);
/** A bug word next to one of these in a path names the chat bug-report workflow. */
const BUG_WORKFLOW_PATH_PARTNERS = new Set([
  'report',
  'reports',
  'triage',
  'suggest',
  'suggestion',
  'suggestions',
  'intake',
  'chat',
  'reaction',
]);

/** Strict kinds a module's path names. */
export function strictKindsInPath(path: string): StrictKind[] {
  const words = pathWords(path);
  const kinds: StrictKind[] = [];
  if (words.includes('slack')) kinds.push('slack');
  if (words.includes('asana')) kinds.push('asana');
  if (words.some((w) => BUG_PATH_WORDS.has(w)) && words.some((w) => BUG_WORKFLOW_PATH_PARTNERS.has(w))) {
    kinds.push('bug-workflow');
  }
  return kinds;
}

/** Strict kinds whose protocol a module body speaks. */
export function strictKindsInContent(body: string): StrictKind[] {
  return (Object.keys(STRICT_CONTENT_MARKERS) as StrictKind[]).filter((k) => STRICT_CONTENT_MARKERS[k].test(body));
}

/**
 * App-code modules that match a strict marker but are not specific to that kind, each with
 * its reason. An entry must keep matching (stale entries fail) and may never name a kind
 * by path. Keep this short; a Slack, Asana or bug-workflow module does not belong here.
 */
export interface StrictAllowance {
  kinds: StrictKind[];
  /** Only these metadata literals are exempt; protocol elsewhere in the file still fails. */
  contentAllowance?: RegExp;
  reason?: string;
}

export const NOT_STRICT_SPECIFIC: Readonly<Record<string, StrictAllowance>> = {
  'packages/operator-core/lib/personal-vault/provider-egress.mjs': {
    kinds: ['slack'],
    reason:
      'egress classifier over every provider host (Google, Microsoft, Slack, Discord, Telegram, ...); ' +
      'Slack is one row of a provider-neutral list',
  },
  'packages/operator-core/lib/db-schema-reference/index-manifest.ts': {
    kinds: ['bug-workflow'],
    reason:
      'GENERATED index census of every table; lists chat_bug_suggestions until the contract ' +
      'migration WI-6554700010008890 drops it, after which this entry goes stale and is removed',
  },
  'packages/operator-core/lib/data-governance/organization-data-receipts.ts': {
    kinds: ['bug-workflow'],
    contentAllowance: /(['"])harness_shared\.chat_bug_suggestions\1/g,
    reason: 'Provider-neutral organization deletion order names a legacy data-source FK child; ' +
      'only the quoted qualified table name is metadata, not the bug-report workflow.',
  },
  'packages/operator-core/lib/data-governance/pilot-processing-map.ts': {
    kinds: ['bug-workflow'],
    contentAllowance: /(['"])harness_shared\.chat_bug_suggestions\1/g,
    reason: 'Provider-neutral retention inventory names the same legacy FK child. ' +
      'The exemption ends when that table leaves the inventory.',
  },
  'packages/operator-core/lib/integrations/provider-census.ts': {
    kinds: ['bug-workflow'],
    contentAllowance: /export const (?:STRICT_CONTENT_MARKERS|NOT_STRICT_SPECIFIC)\b[\s\S]*?\n\};\n/g,
    reason: 'This census module defines the strict markers and this allowance list; only those two ' +
      'definitions are exempt, so protocol code anywhere else in the module still fails.',
  },
};

/**
 * Strict kinds a module body speaks once `path`'s allowance is applied: an allowed kind is
 * dropped unless it survives removal of the allowance's metadata literals. Depends on the
 * body and, only for allowance paths, on the path (see contentVerdictKey).
 */
export function strictContentKindsAfterAllowance(
  path: string,
  body: string,
  allow: Readonly<Record<string, StrictAllowance>> = NOT_STRICT_SPECIFIC,
): StrictKind[] {
  const allowed = new Set(allow[path]?.kinds ?? []);
  const contentAllowance = allow[path]?.contentAllowance;
  const remainingKinds = contentAllowance ? strictKindsInContent(body.replace(contentAllowance, '')) : [];
  return strictKindsInContent(body).filter((k) => !allowed.has(k) || remainingKinds.includes(k));
}

/**
 * The memo key a content verdict may be cached under: the body's identity alone, except for
 * an allowance path, whose verdict also depends on the path.
 */
export function contentVerdictKey(
  path: string,
  bodyIdentity: string,
  allow: Readonly<Record<string, StrictAllowance>> = NOT_STRICT_SPECIFIC,
): string {
  return path in allow ? `${bodyIdentity}\0${path}` : bodyIdentity;
}

/**
 * Every census file specific to a strict kind, as `path: kinds`, sorted by path.
 * `contentKinds(path)` must return strictContentKindsAfterAllowance for that file's body.
 */
export function strictViolationsIn(
  files: Iterable<string>,
  contentKinds: (path: string) => StrictKind[],
): string[] {
  const out: string[] = [];
  for (const f of [...files].sort()) {
    const kinds = [...new Set([...strictKindsInPath(f), ...contentKinds(f)])];
    if (kinds.length > 0) out.push(`${f}: ${kinds.join(', ')}`);
  }
  return out;
}

/** What the census reports about a tree. Both lists sorted; any change to either is a census change. */
export interface ProviderCensusOutput {
  providerSpecificPaths: string[];
  strictViolations: string[];
}

/** The census over a tree's census files (already filtered by isCensusSourcePath). */
export function providerCensusOutput(
  files: readonly string[],
  contentKinds: (path: string) => StrictKind[],
): ProviderCensusOutput {
  return {
    providerSpecificPaths: providerSpecificPathsIn(files),
    strictViolations: strictViolationsIn(files, contentKinds),
  };
}
