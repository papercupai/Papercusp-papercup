/**
 * Provider-specific code census (plan cupboard-distributable-integrations-2026-10-10, P-015).
 *
 * Integrations ship as Cupboard provider packages (libs/papercusp/plugins/*). Any module in
 * app code that exists only to talk to one provider is a leftover from before that model.
 * This test lists every such module and is SHRINK-ONLY:
 *
 *  - a provider-named source file that is not in CENSUS fails the test (the list may not grow);
 *  - a CENSUS entry whose file is gone, or whose content no longer mentions its provider,
 *    fails the test until the entry is removed (the list must stay exact);
 *  - CENSUS_HIGH_WATERMARK must equal CENSUS.length, so every removal lowers the watermark
 *    and raising it is a visible, reviewable diff.
 *
 * Growing the census needs owner sign-off. The fix for a new provider module is a provider
 * package, not a new entry here.
 *
 * Detection is by path: every app-code source path is split into words (directory and file
 * names, kebab/snake/camelCase) and a word equal to a provider token marks it. Modules whose
 * path names no provider but whose body is provider-specific are listed in CENSUS with
 * `detectedBy: 'content'` and a marker the body must still match.
 *
 * Subject root: the repository root, overridable with PROVIDER_CENSUS_ROOT so a mutation
 * probe can point the census at a copy.
 *
 * STRICT kinds (plan cupboard-distributable-integrations-2026-10-10, rubric R-3, D-024
 * ruling 3, P-023): Slack, Asana and the chat bug-report workflow ship only as the slack,
 * asana and bug-triage packages. For these three the census is not an allowance: the
 * census may hold no entry for them, and the strict check fails on ANY app-code module
 * specific to one of them, whatever its path says. A module is specific to a kind when its
 * path names it (a slack/asana path word, or a bug word beside an intake word) or when its
 * body speaks that kind's protocol (STRICT_CONTENT_MARKERS: API hosts, token prefixes, SDK
 * imports, Web API method names, the report-bug callback ids and :bug: reaction). The
 * markers are proven against the real packages, so they describe how this code actually
 * looks, not a guess at it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { bundledSocialProviderDescriptors } from '../capability-verbs/social-provider.fixture';

const REPO_ROOT =
  process.env.PROVIDER_CENSUS_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** App-code roots. Provider packages (libs/papercusp/plugins) are the destination, not app code. */
const APP_ROOTS = [
  'apps/operator',
  'packages/operator-core',
  'packages/agent-mcp',
  'papercusp-desktop/src',
  'orchestrator',
  'bin',
] as const;

const SKIP_DIRS = new Set([
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
const EXCLUDED_TOKENS: Record<string, string> = {
  github: 'platform source-hosting identity, not an integration provider',
};

type CensusGroup = 'google-workspace' | 'discord';

/** Where each group's migration is owned. */
export const MIGRATION_OWNERS: Record<CensusGroup, string> = {
  'google-workspace': 'provider-adapters-to-packages-2026-10-11',
  discord: 'provider-adapters-to-packages-2026-10-11',
};

interface CensusEntry {
  path: string;
  group: CensusGroup;
  detectedBy: 'path' | 'content';
  /** content entries only: the body must still match this, or the entry is stale. */
  marker?: RegExp;
}

const p = (path: string, group: CensusGroup): CensusEntry => ({ path, group, detectedBy: 'path' });

export const CENSUS: readonly CensusEntry[] = [
  // Slack has no entries: cupboard-distributable-integrations-2026-10-10 P-008, P-020 and P-021
  // moved every Slack module into the slack and bug-triage packages (D-019, D-024..D-026).

  // Google Workspace leftovers (Gmail and Calendar already ship as packages).
  p('packages/operator-core/lib/external-triggers/google-workspace.ts', 'google-workspace'),

  // Discord outbound notifications.
  p('apps/operator/app/_components/DiscordChannelLink.tsx', 'discord'),
  p('packages/operator-core/lib/endpoint-route/routes/harness/discord.ts', 'discord'),
  p('packages/operator-core/lib/integrations/discord-webhook-types.ts', 'discord'),
];

/** Lowered by every migration that removes an entry. Raising it needs owner sign-off. */
export const CENSUS_HIGH_WATERMARK = 4;

/**
 * Paths that contain a provider word but are not provider-specific, each with its reason.
 * Keep this short; a provider module does not belong here.
 */
const SOCIAL_DOMAIN_SEAMS = [
  'packages/operator-core/lib/agent-tools/social/delete.ts',
  'packages/operator-core/lib/agent-tools/social/post.ts',
  'packages/operator-core/lib/agent-tools/social/read.ts',
  'packages/operator-core/lib/agent-tools/social/reply.ts',
  'packages/operator-core/lib/agent-tools/social/search.ts',
  'packages/operator-core/lib/capability-verbs/social-delete.ts',
  'packages/operator-core/lib/capability-verbs/social-read.ts',
  'packages/operator-core/lib/capability-verbs/social.ts',
] as const;
const NOT_PROVIDER_SPECIFIC: Record<string, string> = Object.fromEntries(SOCIAL_DOMAIN_SEAMS.map((path) => [
  path, 'Provider-neutral social datatype/authorization/dispatch seam; installed descriptors own vendor selectors, coordinates, capabilities and HTTP. Guarded by the no-social-census test below.',
]));

/** Exact vendor selectors and package egress literals cannot return to a retained domain seam. */
function socialVendorLiterals(source: string): string[] {
  const descriptors = bundledSocialProviderDescriptors();
  const selectors = new Set(descriptors.map((descriptor) => descriptor.id));
  const hosts = descriptors.flatMap((descriptor) => descriptor.egressHosts);
  const found: string[] = [];
  const file = ts.createSourceFile('domain.ts', source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if (selectors.has(value) || hosts.some((host) => value === host || value.includes(`://${host}`))) found.push(value);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec|integration\.test)\.(ts|tsx|mts|js|mjs)$|\.fixture\.ts$/;

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

function walk(absDir: string, out: string[], root: string): void {
  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of names) {
    // dist-* holds esbuild bundles (dist-devhost, dist-sidecar, ...): built copies, not source.
    if (SKIP_DIRS.has(name) || name.startsWith('.') || /^dist-/.test(name)) continue;
    const abs = join(absDir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(abs, out, root);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(relative(root, abs).split(sep).join('/'));
  }
}

/** Every app-code source file under `root` whose path names a provider. */
export function detectProviderSpecificPaths(root = REPO_ROOT): string[] {
  const files: string[] = [];
  for (const r of APP_ROOTS) walk(join(root, r), files, root);
  return files.filter((f) => providerWordsIn(f).length > 0 && !(f in NOT_PROVIDER_SPECIFIC)).sort();
}

/** Provider-specific modules under `root` that the census does not list (growth). */
export function unlistedProviderModules(root: string, census: readonly CensusEntry[]): string[] {
  const listed = new Set(census.map((e) => e.path));
  return detectProviderSpecificPaths(root).filter((f) => !listed.has(f));
}

/** Census entries that no longer describe a provider module under `root` (must be removed). */
export function staleCensusEntries(root: string, census: readonly CensusEntry[]): string[] {
  const detected = new Set(detectProviderSpecificPaths(root));
  const stale: string[] = [];
  for (const e of census) {
    const abs = join(root, e.path);
    if (!existsSync(abs)) {
      stale.push(`${e.path}: file is gone`);
      continue;
    }
    if (e.detectedBy === 'path' && !detected.has(e.path)) stale.push(`${e.path}: path no longer names a provider`);
    if (e.detectedBy === 'content' && !(e.marker && e.marker.test(readFileSync(abs, 'utf8')))) {
      stale.push(`${e.path}: body no longer matches ${String(e.marker)}`);
    }
  }
  return stale;
}

/** Integrations that must leave app code entirely (R-3): no census entry, no allowance. */
export type StrictKind = 'slack' | 'asana' | 'bug-workflow';

/**
 * Protocol markers per strict kind. Each must match the kind's real package (asserted below)
 * and nothing in app code outside NOT_STRICT_SPECIFIC. Web API method names count only as
 * quoted strings, so `deps.conversations.list(...)` or `reviews.push(...)` never match.
 */
export const STRICT_CONTENT_MARKERS: Record<StrictKind, RegExp> = {
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
interface StrictAllowance {
  kinds: StrictKind[];
  /** Only these metadata literals are exempt; protocol elsewhere in the file still fails. */
  contentAllowance?: RegExp;
  reason?: string;
}

export const NOT_STRICT_SPECIFIC: Record<string, StrictAllowance> = {
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
};

/** Every app-code module under `root` specific to a strict kind, as `path: kinds`. */
export function strictViolations(
  root: string,
  allow: Record<string, StrictAllowance> = NOT_STRICT_SPECIFIC,
): string[] {
  const files: string[] = [];
  for (const r of APP_ROOTS) walk(join(root, r), files, root);
  const out: string[] = [];
  for (const f of files.sort()) {
    const byPath = strictKindsInPath(f);
    const allowed = new Set(allow[f]?.kinds ?? []);
    const body = readFileSync(join(root, f), 'utf8');
    const contentAllowance = allow[f]?.contentAllowance;
    const remainingKinds = contentAllowance
      ? strictKindsInContent(body.replace(contentAllowance, ''))
      : [];
    const byContent = strictKindsInContent(body).filter((k) => !allowed.has(k) || remainingKinds.includes(k));
    const kinds = [...new Set([...byPath, ...byContent])];
    if (kinds.length > 0) out.push(`${f}: ${kinds.join(', ')}`);
  }
  return out;
}

/** NOT_STRICT_SPECIFIC entries that no longer match their kinds, or that name a kind by path. */
export function staleStrictAllowances(
  root: string,
  allow: Record<string, StrictAllowance> = NOT_STRICT_SPECIFIC,
): string[] {
  const stale: string[] = [];
  for (const [path, { kinds, contentAllowance }] of Object.entries(allow)) {
    const abs = join(root, path);
    if (!existsSync(abs)) {
      stale.push(`${path}: file is gone`);
      continue;
    }
    if (strictKindsInPath(path).length > 0) stale.push(`${path}: path names a strict kind`);
    const body = readFileSync(abs, 'utf8');
    const found = new Set(strictKindsInContent(body));
    if (contentAllowance && body.replace(contentAllowance, '') === body) {
      stale.push(`${path}: no longer matches content allowance`);
    }
    for (const k of kinds) if (!found.has(k)) stale.push(`${path}: no longer matches ${k}`);
  }
  return stale;
}

/** Build a throwaway repo root holding `files` (repo-relative path -> body). */
function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-census-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe('provider-specific code census (shrink-only)', () => {
  it('detector recognises provider words in every path form it must handle', () => {
    expect(providerWordsIn('apps/operator/app/settings/integrations/SlackSetupCard.tsx')).toEqual(['slack']);
    expect(providerWordsIn('lib/external-triggers/social/bluesky-write-adapter.ts')).toEqual(['social', 'bluesky']);
    expect(providerWordsIn('lib/harness/routines/facebook_personal_vault.ts')).toEqual(['facebook']);
    expect(providerWordsIn('lib/integrations/provider-options.ts')).toEqual([]);
    expect(providerWordsIn('lib/endpoint-route/routes/desktop/github-user.ts')).toEqual([]);
  });

  it('the walk reaches app code (positive control: a non-provider file is seen)', () => {
    const files: string[] = [];
    walk(join(REPO_ROOT, 'packages/operator-core/lib/integrations'), files, REPO_ROOT);
    expect(files).toContain('packages/operator-core/lib/integrations/provider-options.ts');
    expect(files.some((f) => TEST_FILE.test(f))).toBe(false);
  });

  it('control: a new provider module outside the census is caught', () => {
    const root = fixtureRoot({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export {};\n',
      'packages/operator-core/lib/external-triggers/slack.ts': 'export {};\n',
      'apps/operator/app/settings/integrations/DiscordBridgeCard.tsx': 'export {};\n',
      'packages/operator-core/lib/external-triggers/slack.test.ts': 'export {};\n',
    });
    try {
      const census = [p('packages/operator-core/lib/external-triggers/slack.ts', 'discord')];
      expect(unlistedProviderModules(root, census)).toEqual([
        'apps/operator/app/settings/integrations/DiscordBridgeCard.tsx',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: a deleted, renamed or emptied census entry is reported stale', () => {
    const root = fixtureRoot({
      'packages/operator-core/lib/external-triggers/chat-bridge.ts': 'export {};\n',
      'packages/operator-core/lib/integrations/builtin-connection-adapters.ts': 'export const adapters = [];\n',
    });
    try {
      const census: CensusEntry[] = [
        p('packages/operator-core/lib/external-triggers/slack.ts', 'discord'),
        p('packages/operator-core/lib/external-triggers/chat-bridge.ts', 'discord'),
        {
          path: 'packages/operator-core/lib/integrations/builtin-connection-adapters.ts',
          group: 'google-workspace',
          detectedBy: 'content',
          marker: /facebook/i,
        },
      ];
      expect(staleCensusEntries(root, census)).toEqual([
        'packages/operator-core/lib/external-triggers/slack.ts: file is gone',
        'packages/operator-core/lib/external-triggers/chat-bridge.ts: path no longer names a provider',
        'packages/operator-core/lib/integrations/builtin-connection-adapters.ts: body no longer matches /facebook/i',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no provider-specific module exists in app code outside the census', () => {
    expect(
      unlistedProviderModules(REPO_ROOT, CENSUS),
      `New provider-specific modules in app code. Ship the integration as a provider package in ` +
        `libs/papercusp/plugins instead (see /internal/docs/plugins). Growing the census needs owner sign-off.`,
    ).toEqual([]);
  });

  it('every census entry still exists and is still provider-specific (stale entries must be removed)', () => {
    expect(
      staleCensusEntries(REPO_ROOT, CENSUS),
      'Remove these entries from CENSUS and lower CENSUS_HIGH_WATERMARK.',
    ).toEqual([]);
  });

  it('the census is exact and its watermark only ratchets down', () => {
    expect(new Set(CENSUS.map((e) => e.path)).size).toBe(CENSUS.length);
    expect(CENSUS.length).toBe(CENSUS_HIGH_WATERMARK);
  });

  it('every census group has an owned migration', () => {
    for (const e of CENSUS) expect(MIGRATION_OWNERS[e.group], e.path).toMatch(/\S/);
  });

  it('Facebook Pages and Personal Vault stay package-owned', () => {
    expect(Object.keys(MIGRATION_OWNERS)).not.toContain('facebook-vault');
    expect(CENSUS.filter((e) => /facebook/i.test(e.path))).toEqual([]);
    const root = fixtureRoot({
      'packages/operator-core/lib/external-triggers/social/facebook-posts-adapter.ts': 'export {};\n',
    });
    try {
      expect(unlistedProviderModules(root, CENSUS)).toEqual([
        'packages/operator-core/lib/external-triggers/social/facebook-posts-adapter.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the census holds no social group or entry', () => {
    expect(Object.keys(MIGRATION_OWNERS)).not.toContain('social');
    expect(CENSUS.filter((entry) => providerWordsIn(entry.path).includes('social'))).toEqual([]);
    for (const path of SOCIAL_DOMAIN_SEAMS) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
      expect(socialVendorLiterals(readFileSync(join(REPO_ROOT, path), 'utf8')), path).toEqual([]);
    }
    expect(socialVendorLiterals("if (platform === 'reddit') fetch('https://oauth.reddit.com/api');"))
      .toEqual(['reddit', 'https://oauth.reddit.com/api']);
    expect(socialVendorLiterals("registry.get(platform).adapter.invoke(request); // reddit is documentation"))
      .toEqual([]);
  });
});

describe('strict R-3 check: no Slack, Asana or bug-workflow module in app code', () => {
  it('the census holds no slack, asana or bug-workflow group or entry', () => {
    expect(Object.keys(MIGRATION_OWNERS).filter((g) => /slack|asana|bug/i.test(g))).toEqual([]);
    expect(CENSUS.filter((e) => strictKindsInPath(e.path).length > 0).map((e) => e.path)).toEqual([]);
    const strictBodies = CENSUS.filter(
      (e) => existsSync(join(REPO_ROOT, e.path)) && strictKindsInContent(readFileSync(join(REPO_ROOT, e.path), 'utf8')).length > 0,
    );
    expect(strictBodies.map((e) => e.path)).toEqual([]);
  });

  it('positive control: the markers recognise the real slack, asana and bug-triage packages', () => {
    const pkg = (rel: string) => readFileSync(join(REPO_ROOT, 'libs/papercusp/plugins', rel), 'utf8');
    expect(strictKindsInContent(pkg('slack/provider.mjs'))).toContain('slack');
    expect(strictKindsInContent(pkg('asana/index.cjs'))).toContain('asana');
    expect(strictKindsInContent(pkg('bug-triage/papercusp.json'))).toContain('bug-workflow');
  });

  it('negative control: generic code that only says "slack" or shares a method name is not flagged', () => {
    for (const body of [
      'export const ECHO_ABSORB_SLACK_MS = 400; // timer slack, not the provider\n',
      "if (review?.status === 'pending') reviews.push(timing.reviewWaitMs);\n",
      'return deps.conversations.list(input);\n',
      '<a href="https://github.com/x/y/issues/new">🐛 Open a GitHub issue</a>\n',
      "export const kinds = ['bug', 'feature', 'change'] as const;\n",
    ]) {
      expect(strictKindsInContent(body), body).toEqual([]);
    }
    expect(strictKindsInPath('packages/operator-core/lib/attention/bug-reproduction.ts')).toEqual([]);
    expect(strictKindsInPath('packages/operator-core/lib/agent-tools/operator/voice_debug.ts')).toEqual([]);
  });

  it('control: a planted module of each kind fails the check, whatever its path says', () => {
    const root = fixtureRoot({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export {};\n',
      // Content only: none of these paths names a provider.
      'packages/operator-core/lib/chat/thread-poster.ts':
        "await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body });\n",
      'packages/operator-core/lib/tickets/task-sync.ts':
        "const url = 'https://app.asana.com/api/1.0/tasks?opt_fields=name,completed';\n",
      'packages/operator-core/lib/intake/message-classifier.ts':
        "if (payload.callback_id === 'report_bug') await fileTicket(payload);\n",
      // Path only: the body is empty.
      'apps/operator/app/settings/integrations/AsanaProjectPicker.tsx': 'export {};\n',
      'packages/operator-core/lib/admission/chat-bug-intake.ts': 'export {};\n',
      'packages/operator-core/lib/release/gate-fire-drill.ts': 'export const DRILL_WINDOW_SLACK_MS = 5_000;\n',
      // Tests are not app code.
      'packages/operator-core/lib/chat/thread-poster.test.ts': "fetch('https://slack.com/api/chat.postMessage');\n",
    });
    try {
      expect(strictViolations(root, {})).toEqual([
        'apps/operator/app/settings/integrations/AsanaProjectPicker.tsx: asana',
        'packages/operator-core/lib/admission/chat-bug-intake.ts: bug-workflow',
        'packages/operator-core/lib/chat/thread-poster.ts: slack',
        'packages/operator-core/lib/intake/message-classifier.ts: bug-workflow',
        'packages/operator-core/lib/tickets/task-sync.ts: asana',
      ]);
      // An allowance hides a content match only, never a path that names the kind,
      // and an allowance for a path-named module is itself reported.
      const allow = {
        'packages/operator-core/lib/chat/thread-poster.ts': { kinds: ['slack' as const] },
        'apps/operator/app/settings/integrations/AsanaProjectPicker.tsx': { kinds: ['asana' as const] },
      };
      expect(strictViolations(root, allow)).toContain('apps/operator/app/settings/integrations/AsanaProjectPicker.tsx: asana');
      expect(strictViolations(root, allow)).not.toContain('packages/operator-core/lib/chat/thread-poster.ts: slack');
      expect(staleStrictAllowances(root, allow)).toEqual([
        'apps/operator/app/settings/integrations/AsanaProjectPicker.tsx: path names a strict kind',
        'apps/operator/app/settings/integrations/AsanaProjectPicker.tsx: no longer matches asana',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no module specific to Slack, Asana or the bug workflow exists in app code', () => {
    expect(
      strictViolations(REPO_ROOT),
      'Slack, Asana and the chat bug workflow ship only as the slack, asana and bug-triage packages ' +
        '(libs/papercusp/plugins). Move this code into the package, or make it provider-neutral.',
    ).toEqual([]);
  });

  it('governance metadata exemptions cannot hide a restored provider implementation', () => {
    const path = 'packages/operator-core/lib/data-governance/organization-data-receipts.ts';
    const root = fixtureRoot({ [path]: "export const stores = ['harness_shared.chat_bug_suggestions'];\n" });
    try {
      const allow = { [path]: NOT_STRICT_SPECIFIC[path]! };
      expect(strictViolations(root, {})).toEqual([`${path}: bug-workflow`]);
      expect(strictViolations(root, allow)).toEqual([]);
      writeFileSync(join(root, path), "export const stores = ['harness_shared.chat_bug_suggestions'];\nexport const reaction = ':bug:';\n");
      expect(strictViolations(root, allow)).toEqual([`${path}: bug-workflow`]);
      writeFileSync(join(root, path), "export const reaction = ':bug:';\n");
      expect(staleStrictAllowances(root, allow)).toEqual([`${path}: no longer matches content allowance`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('every strict allowance still applies and names no kind by path', () => {
    expect(staleStrictAllowances(REPO_ROOT), 'Remove these entries from NOT_STRICT_SPECIFIC.').toEqual([]);
  });
});
