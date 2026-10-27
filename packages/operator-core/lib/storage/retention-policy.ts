import { retentionPinProtectsPath } from '../../../../scripts/lib/retention-pins.mjs';
import { hostWorkspaceRootPattern } from '../workspace-root';

/**
 * Written retention policy for disk consumers on `/`, `/mnt/data` and `/mnt/backup`
 * (plan disk-headroom-standing-reclaim-2026-10-12, P-003 / R-2; `/mnt/backup`
 * classes added for WI-6554700010011387, all keep or review).
 *
 * WHAT THIS IS: the single source that says, for every class of thing the disk
 * census (`disk-consumer-census.ts`) reports, who made it, how long it is kept,
 * and which code enforces that on a schedule. The standing reclaim (P-004) may
 * delete ONLY through {@link deletionClassFor}, which fails closed: a path that
 * maps to no class, to two classes at the same specificity, or to a class whose
 * keep rule is `keep` / `review` is never selected.
 *
 * Owner rulings this encodes (plan decisions, see `plans:get`):
 *   - D-002 [owner 2026-10-12]: the cleanup may delete agent-generated
 *     leftovers on its own under this written policy; never owner data
 *     (/mnt/data Backup/kopia, recordings, Debug, db, back) and never the swapfile.
 *   - D-005 [owner 2026-10-13]: every rule runs on its own schedule, not
 *     only when free space is low. So a deletable class must name a scheduled
 *     enforcer: an existing scheduled one, or the standing reclaim.
 *   - R-3 of disk-durable-headroom-2026-10-15 [owner 2026-10-15]: agent-made
 *     folders are deleted 3 days after their last write ({@link AGENT_MAX_AGE_HOURS});
 *     build output inside them after 1 day ({@link BUILD_DIR_MAX_AGE_HOURS}). Every
 *     path under an agent root that no narrower class claims inherits that
 *     root's expiry; owner and system data stay on the explicit protected list.
 *
 * Reuse: deletable classes point at the existing enforcers (scratch-gc,
 * session-dir-gc, fleet-logs-gc, reclaim-docker-disk.sh, reclaim-tmp-scratch-
 * residue.sh, package-cache-retention, release-cut-reclaim, the sidecar
 * failed-stage prune). The standing reclaim only fills the gaps; it never
 * becomes a second deleter for a class that already has one.
 *
 * Path patterns: absolute, or `~/…` for the home directory. A segment is a
 * literal, a glob with `*` (never crossing `/`), or `re:<regex>` matched
 * against the whole segment. A pattern covers its root and everything under
 * it. When several roots cover a path the most specific wins (per segment:
 * literal 3 > regex 2 > partial glob 1 > `*` 0, then more segments); an exact
 * tie between two different classes is a CONFLICT and fails closed.
 */
import { homedir } from 'node:os';
import { normalize } from 'node:path';

const WORKSPACE_ROOT_TOKEN = '__PAPERCUSP_WORKSPACE_ROOT__';

export type RetentionOrigin = 'agent' | 'owner' | 'system';

/** One keep rule per class (R-2: "exactly one keep rule"). */
export type KeepRule =
  /**
   * each direct child entry is eligible this long after its newest write.
   * `buildDirMaxAgeHours`: rebuildable build output inside an entry (see
   * {@link isBuildDirName} / {@link isCacheDirTag}) is eligible earlier, once the
   * whole ENTRY has had no write for that long. The entry's newest write decides,
   * not the build dir's own, so an agent still working in a copy keeps its
   * node_modules even when the install itself is old.
   */
  | { kind: 'max-age'; maxAgeHours: number; buildDirMaxAgeHours?: number }
  /** keep the newest `keep` children (by newest write); older ones are eligible. */
  | { kind: 'newest'; keep: number; maxAgeHours?: number }
  /** kept while a live record (lease, registration, live session) names it, then a grace period. */
  | { kind: 'lease'; record: string; graceHours: number }
  /** the owning program applies its own retention (docker prune ages, snapd, npm cache, journald). */
  | { kind: 'native'; manager: string; rule: string }
  /** protected: never deleted by any automatic path. */
  | { kind: 'keep'; reason: string }
  /** agent-generated, but no rule is yet safe to automate: never deleted, size reported each run. */
  | { kind: 'review'; reason: string };

export type Enforcer =
  /** an existing scheduled deleter owns the class. `ref` is repo-qualified. */
  | { kind: 'existing'; ref: string; schedule: string; sourceSha256?: string }
  /** the standing reclaim (P-004) runs it on its schedule, optionally by calling `via`. */
  | { kind: 'standing-reclaim'; via?: string; sourceSha256?: string }
  /** a program outside this repo (apt, snapd, journald, the tool itself). */
  | { kind: 'external'; manager: string }
  /** nothing deletes it (keep / review classes). */
  | { kind: 'none' };

/** R-5 membership is independent of attribution and deletion permission. An
 * unresolved mixed parent is retained, but cannot disappear from acceptance. */
export type RetentionAcceptance =
  | { kind: 'disposable'; owner: string; provenance: string[] }
  | { kind: 'protected'; reason: string; provenance: string[] }
  | { kind: 'unresolved'; reason: string; provenance: string[] };

export interface RetentionClass {
  id: string;
  title: string;
  origin: RetentionOrigin;
  /** path patterns (see header). */
  roots: string[];
  /** non-path census keys this class owns, matched by prefix (`docker:`, `postgres:`). */
  stores?: string[];
  /** Explicit R-5 partition. Optional for caller-supplied policies; absence is
   * an acceptance failure, never an inferred protected/disposable scope. */
  acceptance?: RetentionAcceptance;
  keep: KeepRule;
  /** Allocated-byte ceiling per physical root for the owning collector. Pins
   * count toward usage but remain exempt from eviction. */
  maxBytes?: number;
  /** every enforcer that acts on the class; the first is primary. */
  enforcers: Enforcer[];
  note?: string;
}

/** Hours per day; keep rules are stated in hours. */
const DAY = 24;

/**
 * The ceiling for every agent-made folder: deleted 3 days after its last write
 * (owner 2026-10-15, session 956a3058 turn 9, plan disk-durable-headroom-2026-10-15
 * R-3). Agents pin anything they need longer (P-006). A class may expire sooner
 * (shared /tmp keeps 4 h); {@link validatePolicy} refuses a max-age class above it.
 */
export const AGENT_MAX_AGE_HOURS = 3 * DAY;

/** Default per-root ceiling. Lease collectors keep their live/archive guards
 * and report protected overage; native managers own their admission limits. */
export const AGENT_ROOT_MAX_BYTES = 20 * 1024 ** 3;
/** Existing native package-cache janitor's per-root high-water mark. */
export const PACKAGE_CACHE_ROOT_MAX_BYTES = 8 * 1024 ** 3;
export function retentionRootSizeCap(cls: RetentionClass): number | undefined {
  return cls.origin === 'agent' && (cls.keep.kind === 'max-age' || cls.keep.kind === 'newest')
    ? cls.maxBytes : undefined;
}

/**
 * Build output inside an agent entry (node_modules, Cargo target dirs) is
 * rebuildable, so it goes after 1 day without a write to the entry
 * [derived from the approved plan design, R-3].
 */
export const BUILD_DIR_MAX_AGE_HOURS = DAY;

/** Directory names that only ever hold rebuildable build output. */
export const BUILD_DIR_NAMES: readonly string[] = ['node_modules'];

/**
 * First line of a CACHEDIR.TAG per the Cache Directory Tagging spec
 * (https://bford.info/cachedir/). A directory holding a tag that starts with
 * this line declares itself regenerable; Cargo writes one in every target dir,
 * whatever the dir is named (`target`, `cargo-target`, a slot path).
 */
export const CACHEDIR_TAG_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

/** True for a directory name that is always build output. */
export function isBuildDirName(name: string): boolean {
  return BUILD_DIR_NAMES.includes(name);
}

/** True when `tagContents` (a CACHEDIR.TAG file's text) carries the spec signature. */
export function isCacheDirTag(tagContents: string | null | undefined): boolean {
  return typeof tagContents === 'string' && tagContents.startsWith(CACHEDIR_TAG_SIGNATURE);
}

/**
 * Whether build dirs inside an entry of a class with `rule` may go now: the rule
 * names a build-dir bound and the entry's newest write is older than it.
 */
export function buildDirsEligible(rule: KeepRule, entryNewestWriteMs: number, nowMs: number): boolean {
  if (rule.kind !== 'max-age' || rule.buildDirMaxAgeHours === undefined) return false;
  return nowMs - entryNewestWriteMs > rule.buildDirMaxAgeHours * 3_600_000;
}

/**
 * Names that never denote disposable run output, whatever else they contain:
 * a backup, key, credential, login, signing or custody dir/file is kept even
 * when it carries a date or a work-item id. `wh-release-` names belong to
 * their own review class; a regex root would otherwise outrank its glob.
 */
const PROTECTED_NAME = '(?!.*(?:[Bb]ackup|BACKUP|[Kk]ey|[Cc]red|[Aa]uth|[Ss]ecret|[Tt]oken|[Ll]ogin|[Ss]igning|[Cc]ustody|[Pp]assword|wal-)|wh-release-)';

/**
 * Run-output naming conventions at the top of ~/.papercusp: a plan-item prefix
 * (`p046-r26-publication`), a work-item id (`tutorial-mcp-wi7747`,
 * `cache-reclaim-preserve-EI-21047688909295463`) or a date stamp
 * (`db-perf-scout-2026-08-02`, `cloud-e2e-20261009`).
 */
export const HOME_RUN_DIR_PATTERNS: readonly string[] = [
  `~/.papercusp/re:${PROTECTED_NAME}p[0-9]{3}(?:[-_.].*)?`,
  `~/.papercusp/re:${PROTECTED_NAME}(?:.*[-_.])?(?:wi|WI|ei|EI)-?[0-9]{3,}(?:[-_.].*)?`,
  `~/.papercusp/re:${PROTECTED_NAME}.*20[0-9]{2}-?[01][0-9]-?[0-3][0-9].*`,
];

/** The max-age rule every agent root gets unless it needs a shorter bound. */
const AGENT_DEFAULT_RULE: KeepRule = {
  kind: 'max-age',
  maxAgeHours: AGENT_MAX_AGE_HOURS,
  buildDirMaxAgeHours: BUILD_DIR_MAX_AGE_HOURS,
};

const disposable = (owner: string, ...provenance: string[]): RetentionAcceptance =>
  ({ kind: 'disposable', owner, provenance });
const protectedScope = (reason: string, ...provenance: string[]): RetentionAcceptance =>
  ({ kind: 'protected', reason, provenance });
const unresolved = (reason: string, ...provenance: string[]): RetentionAcceptance =>
  ({ kind: 'unresolved', reason, provenance });
const STORAGE_AUTHORITY = 'plan:disk-durable-headroom-2026-10-15#D-018';
const STANDING_OWNER = 'papercusp/packages/operator-core/lib/storage/disk-reclaim.ts';

/**
 * The policy. Order does not matter (specificity decides), but classes are
 * grouped: protected owner/system data first, then agent classes with an
 * existing enforcer, then agent classes the standing reclaim enforces, then
 * review-only classes.
 */
const BASE_RETENTION_POLICY: readonly RetentionClass[] = [
  // ── Protected: owner data (D-002) ────────────────────────────────────────
  {
    id: 'owner-data-mnt',
    acceptance: protectedScope('Owner backups, recordings and data are explicitly outside automatic deletion.', STORAGE_AUTHORITY),
    title: 'Owner backups, recordings and project data on /mnt/data',
    origin: 'owner',
    roots: [
      '/mnt/data/Backup',
      '/mnt/data/*-recordings',
      '/mnt/data/Debug*',
      '/mnt/data/db',
      '/mnt/data/back',
      '/mnt/data/MEMORYSTORE',
      // The HDD cold tier (disk-durable-headroom-2026-10-15 P-004): backups on
      // cold-a, owner copies on cold-b. /mnt/data/<name> is left as a symlink.
      '/mnt/cold-a/Backup',
      '/mnt/cold-b/Debug*',
      '/mnt/cold-b/back',
    ],
    keep: { kind: 'keep', reason: 'owner data, never automatic (D-002)' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'cold-tier',
    acceptance: protectedScope('Owner archive volumes accept deliberate moves only (R-7).', STORAGE_AUTHORITY),
    title: 'The HDD cold tier (/mnt/cold-a, /mnt/cold-b) and its move logs',
    origin: 'system',
    roots: ['/mnt/cold-a', '/mnt/cold-b'],
    keep: { kind: 'keep', reason: 'archive volumes: only deliberate moves land here, each under its own class' },
    enforcers: [{ kind: 'none' }],
    note: 'Never a target for build output or agent scratch (plan disk-durable-headroom-2026-10-15, R-7).',
  },
  {
    id: 'owner-home',
    acceptance: protectedScope('Owner projects and personal application data.', STORAGE_AUTHORITY),
    title: 'Owner projects and app data in the home directory',
    origin: 'owner',
    roots: [
      '~/Android',
      '~/Restart',
      '~/storewolf-central-server*',
      '~/automaker',
      '~/.vscode-demo',
      '~/astro-ecommerce',
      '~/snap',
      '~/.config',
      '~/.vscode',
      '~/.voicemode',
      '~/.oddsmith',
      '~/Documents',
      '~/Downloads',
      '~/Desktop',
      '~/Pictures',
      '~/Videos',
      '~/Music',
    ],
    keep: { kind: 'keep', reason: 'owner projects and application data' },
    enforcers: [{ kind: 'none' }],
  },
  // ── Protected: system ────────────────────────────────────────────────────
  {
    id: 'swap',
    acceptance: protectedScope('Active swap files are explicit system exclusions (D-002).', STORAGE_AUTHORITY),
    title: 'Swap files',
    origin: 'system',
    roots: ['/swap.img', '/mnt/data/swapfile'],
    keep: { kind: 'keep', reason: 'swap, never automatic (D-002)' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'os',
    acceptance: protectedScope('Operating-system/package stores are not agent run roots.', STORAGE_AUTHORITY),
    title: 'Operating system, packages and system logs',
    origin: 'system',
    roots: ['/usr', '/opt', '/boot', '/snap', '/root', '/srv', '/var/lib/snapd', '/var/lib/apt', '/var/lib/dpkg', '/var/lib/flatpak', '/var/log', '/var/cache', '/var/tmp', '/var/lib/waydroid', '/home/linuxbrew', '/tmp/systemd-private-*', '/mnt/data/tmp/systemd-private-*'],
    keep: { kind: 'native', manager: 'apt/snapd/journald/logrotate', rule: 'each owns its retention' },
    enforcers: [{ kind: 'external', manager: 'apt/snapd/journald/logrotate' }],
  },
  {
    id: 'snap-download-cache',
    acceptance: protectedScope('System package downloads; owned by snapd rather than an agent run.', 'papercusp/packages/operator-core/lib/storage/snap-cache-retention.ts'),
    title: 'Snapd download cache',
    origin: 'system',
    roots: ['/var/lib/snapd/cache'],
    keep: { kind: 'native', manager: 'snapd', rule: "snapd's own cache policy, requested by the checkpoint under pressure" },
    enforcers: [
      { kind: 'external', manager: 'snapd' },
      { kind: 'existing', ref: 'papercusp/packages/operator-core/lib/storage/snap-cache-retention.ts', schedule: 'green-checkpoint disk preflight' },
    ],
  },
  {
    id: 'postgres-cluster',
    acceptance: protectedScope('Live database files; retention operates on rows.', STORAGE_AUTHORITY, 'papercusp/packages/operator-core/lib/storage/table-retention.ts'),
    title: 'Native Postgres cluster',
    origin: 'system',
    roots: ['/var/lib/postgresql'],
    stores: ['postgres:'],
    keep: { kind: 'keep', reason: 'live database files; growth is cut by row retention inside Postgres (P-002), never by deleting files' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'live-databases',
    acceptance: protectedScope('Live workspace database files.', STORAGE_AUTHORITY, 'papercusp/packages/operator-core/lib/workspace-registry.ts'),
    title: 'Embedded Postgres data directories and hive databases',
    origin: 'system',
    roots: ['~/.papercusp-workspaces/.shared/embedded-pg-data', '~/.papercusp/hives/*/db'],
    keep: { kind: 'keep', reason: 'live database files' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'hyperbee-store',
    acceptance: protectedScope('Live product stores are explicitly protected.', STORAGE_AUTHORITY),
    title: 'Workspace Hyperbee/Corestore data',
    origin: 'system',
    roots: ['~/.papercusp-workspaces/*/.papercusp/*/hyperbee', '~/.papercusp-workspaces/*/.papercusp/*/hyperbee-scoped'],
    keep: { kind: 'keep', reason: 'product data; growth needs log compaction, not file deletion' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'toolchains-and-tool-state',
    acceptance: unresolved('Mixed tool state may contain credentials, toolchains and generated caches; needs writer-scoped children.', STORAGE_AUTHORITY),
    title: 'Toolchains and per-tool state (rustup, cargo, codex, claude, local libs)',
    origin: 'system',
    roots: ['~/.rustup', '~/.cargo', '~/.codex', '~/.claude', '~/.local/lib', '~/.local/share', '~/.local/bin', '~/.nvm', '~/.bun', '~/go', '~/.gradle'],
    keep: { kind: 'native', manager: 'each tool', rule: 'the tool owns its own state and caches' },
    enforcers: [{ kind: 'external', manager: 'each tool' }],
  },
  {
    id: 'user-caches',
    acceptance: unresolved('Per-tool cache attribution alone does not prove non-agent scope or a finite owner cap.', STORAGE_AUTHORITY),
    title: 'Per-tool caches under ~/.cache',
    origin: 'system',
    roots: ['~/.cache'],
    keep: { kind: 'native', manager: 'each tool', rule: 'each tool owns its cache (kopia, go-build, pip, …)' },
    enforcers: [{ kind: 'external', manager: 'each tool' }],
  },
  // ── Protected: live agent/platform state ────────────────────────────────
  {
    id: 'source-checkouts',
    acceptance: unresolved('Whole checkouts are mixed; only separately classified generated children may expire.', 'papercusp/packages/operator-core/lib/workspace-root.ts'),
    title: 'Git checkouts under the configured Papercusp workspace root',
    origin: 'agent',
    roots: [`${WORKSPACE_ROOT_TOKEN}/*`],
    keep: { kind: 'keep', reason: 'project checkouts; their scratch, tmp and release-cut trees are separate classes' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'workspace-state',
    acceptance: unresolved('Live workspace parent includes product state and disposable descendants.', 'papercusp/packages/operator-core/lib/workspace-registry.ts'),
    title: 'Registered workspace state (~/.papercusp-workspaces/<ws>)',
    origin: 'agent',
    roots: ['~/.papercusp-workspaces/.shared', '~/.papercusp-workspaces/*/.papercusp'],
    keep: { kind: 'keep', reason: 'live workspace state; its logs, snapshots and dumps are separate classes' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'papercusp-home-state',
    acceptance: unresolved('Mixed credentials, live platform stores and run output require narrow writer-owned children.', STORAGE_AUTHORITY),
    title: 'Platform state under ~/.papercusp',
    origin: 'agent',
    roots: ['~/.papercusp', '~/.papercusp/pot-git', '~/.papercusp/hives', '~/.local/state/papercusp'],
    keep: { kind: 'keep', reason: 'platform state (git mirrors, hives, receipts); its scratch, evidence and session dirs are separate classes' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'gitnexus-index',
    acceptance: unresolved('Live index attribution does not establish acceptance exclusion for every child.', STORAGE_AUTHORITY),
    title: 'GitNexus code index',
    origin: 'agent',
    roots: ['/mnt/data/gitnexus'],
    keep: { kind: 'keep', reason: 'live code index, rebuilt in place' },
    enforcers: [{ kind: 'none' }],
  },
  // ── Agent classes with an existing scheduled enforcer ────────────────────
  {
    id: 'tmp-scratch',
    acceptance: disposable(STANDING_OWNER, STANDING_OWNER),
    title: 'Shared agent scratch (/tmp and its data-disk alias)',
    origin: 'agent',
    roots: ['/mnt/data/tmp', '/tmp'],
    keep: { kind: 'max-age', maxAgeHours: 4 },
    enforcers: [{ kind: 'standing-reclaim' }],
    note: 'One age/lease/holder-aware executor for both bind-mount aliases; the legacy name-only shell actor is retired.',
  },
  {
    id: 'container-storage',
    acceptance: disposable('papercusp/bin/reclaim-docker-disk.sh', 'papercusp/bin/reclaim-docker-disk.sh'),
    title: 'Docker and Podman storage (build cache, images, volumes, containers)',
    origin: 'agent',
    roots: ['/var/lib/docker', '/var/lib/containers'],
    stores: ['docker:'],
    keep: { kind: 'native', manager: 'docker/podman', rule: 'build cache 24h, unreferenced images 168h, dangling anonymous volumes 24h' },
    maxBytes: AGENT_ROOT_MAX_BYTES,
    enforcers: [{ kind: 'existing', ref: 'papercusp/bin/reclaim-docker-disk.sh', schedule: 'papercup-docker-reclaim.timer, hourly at :17', sourceSha256: '5025a9e6f3f6cb1f320e9d05bb4d3b90f8e2d16a92f3444f031ded2c64342767' }],
    note: 'The native owner discovers DockerRootDir and both Podman GraphRoots, deduplicates physical stores, and reports allocated-byte cap residue; these default roots are not an exhaustive inventory. Native references, named volumes and pins remain protected. Leaked Postgres test containers are fixed at the source by P-005 (R-4).',
  },
  {
    id: 'papercusp-scratch',
    acceptance: disposable(STANDING_OWNER, 'papercusp/packages/operator-core/lib/scratch-gc.ts'),
    title: 'Tool and agent scratch under ~/.papercusp/scratch',
    origin: 'agent',
    roots: ['~/.papercusp/scratch'],
    keep: AGENT_DEFAULT_RULE,
    enforcers: [
      { kind: 'existing', ref: 'papercusp/packages/operator-core/lib/scratch-gc.ts', schedule: 'DBOS scratchGc, daily 03:00 (workspace run dirs, 24h)' },
      { kind: 'standing-reclaim' },
    ],
    note: 'scratch-gc deletes workspace run dirs after 24h but never ad-hoc top-level dirs; the standing reclaim applies the 3-day bound to those.',
  },
  {
    id: 'session-dirs',
    acceptance: disposable('papercusp/packages/operator-core/lib/session-dir-gc.ts', 'papercusp/packages/operator-core/lib/session-dir-gc.ts'),
    title: 'Per-session agent dirs (Claude config, MCP config, Codex homes)',
    origin: 'agent',
    roots: [
      '~/.papercusp/session-claude',
      '~/.papercusp/session-mcp',
      '~/.papercusp/su-codex-homes',
      '~/.papercusp/codex-sqlite-homes',
      '~/.papercusp/role-codex-homes',
      '/mnt/data/tmp/papercusp-codex-sqlite-homes',
    ],
    keep: { kind: 'lease', record: 'a live or resumable session', graceHours: 2 },
    maxBytes: AGENT_ROOT_MAX_BYTES,
    enforcers: [{ kind: 'existing', ref: 'papercusp/packages/operator-core/lib/session-dir-gc.ts', schedule: 'DBOS sessionDirGc (periodic)' }],
  },
  {
    id: 'fleet-logs',
    acceptance: disposable('papercusp/packages/operator-core/lib/fleet-logs-gc.ts', 'papercusp/packages/operator-core/lib/fleet-logs-gc.ts'),
    title: 'Headless fleet session logs and launch-context renders',
    origin: 'agent',
    roots: ['~/.papercusp-workspaces/*/.papercusp/fleet-logs', '~/.papercusp/launch-context'],
    keep: { kind: 'max-age', maxAgeHours: 3 * DAY },
    enforcers: [{ kind: 'existing', ref: 'papercusp/packages/operator-core/lib/fleet-logs-gc.ts', schedule: 'DBOS fleetLogsGc (periodic)' }],
    note: 'launch-context renders use the same module with a 7-day bound.',
  },
  {
    id: 'package-caches',
    acceptance: disposable('papercusp/packages/operator-core/lib/storage/package-cache-retention.ts', 'papercusp/packages/operator-core/lib/storage/package-cache-retention.ts'),
    title: 'npm, bun and pnpm package caches',
    origin: 'agent',
    roots: ['~/.npm', '~/.bun/install/cache', '~/.local/share/pnpm/store'],
    keep: { kind: 'native', manager: 'npm/bun/pnpm', rule: 'native cache cleanup once the configured high-water mark is crossed' },
    maxBytes: PACKAGE_CACHE_ROOT_MAX_BYTES,
    enforcers: [{ kind: 'existing', ref: 'papercusp/packages/operator-core/lib/storage/package-cache-retention.ts', schedule: 'telemetry-retention routine' }],
  },
  {
    id: 'sidecar-failed-stages',
    acceptance: disposable('papercusp/papercusp-desktop/bin/lib/sidecar-stage-state.js prune', 'papercusp/papercusp-desktop/bin/lib/sidecar-stage-state.js'),
    title: 'Failed desktop sidecar build stages',
    origin: 'agent',
    roots: ['~/.local/state/papercusp/sidecar-failed-stages'],
    keep: { kind: 'newest', keep: 1, maxAgeHours: 24 },
    enforcers: [
      { kind: 'existing', ref: 'papercusp/papercusp-desktop/bin/lib/sidecar-stage-state.js prune', schedule: 'every sidecar build start' },
      { kind: 'standing-reclaim', via: 'papercusp/papercusp-desktop/bin/lib/sidecar-stage-state.js prune --all' },
    ],
    note: 'Newest resumable stage per output, under 24h; WI-6554700010010442. The scheduled call is WI-6554700010010489.',
  },
  {
    id: 'vh-release-runs',
    acceptance: disposable('papercusp/libs/generic/verification-harness/src/runner.ts pruneRunsWithReport', 'papercusp/libs/generic/verification-harness/src/runner.ts:runHarness'),
    title: 'Verification-harness release runs',
    origin: 'agent',
    roots: ['~/.local/state/verification-harness/release-local', '/mnt/data/offload/verification-harness/release-local'],
    keep: { kind: 'newest', keep: 30 },
    enforcers: [
      {
        kind: 'existing',
        ref: 'papercusp/libs/generic/verification-harness/src/runner.ts pruneRunsWithReport',
        schedule: 'start of every harness run (bin/vh.sh `cli.ts retain`; count floor VH_KEEP_RUNS, default 30, plus the reserve-aware pass)',
      },
    ],
    note: 'Foreign (hand-parked) entries are pruned by pruneEvidenceRoot in the same module at finalize; see WI-6554700010010390.',
  },
  {
    id: 'vh-isolated-runs',
    acceptance: disposable('papercusp/libs/generic/verification-harness/src/runner.ts pruneEvidenceRoot', 'papercusp/libs/generic/verification-harness/src/runner.ts'),
    title: 'Verification-harness isolated integration runs',
    origin: 'agent',
    roots: [
      '~/.local/state/verification-harness/isolated-integration',
      '/mnt/data/offload/verification-harness/isolated-integration',
    ],
    keep: { kind: 'newest', keep: 30 },
    enforcers: [
      {
        kind: 'existing',
        ref: 'papercusp/libs/generic/verification-harness/src/runner.ts pruneEvidenceRoot',
        schedule: 'after each isolated-integration harness run (recordIsolatedIntegrationProof)',
      },
    ],
    note: 'The runner retains immutable originals under retained/ and prunes completed runs plus foreign entries under its retention mutex. This class names that owner explicitly; the generic standing reclaim does not sweep retained receipts.',
  },
  // ── Agent classes the standing reclaim enforces ──────────────────────────
  {
    id: 'release-cut-worktrees',
    acceptance: disposable('papercusp/packages/operator-core/lib/release-cut-reclaim.ts', 'papercusp/packages/operator-core/lib/agent-tools/release/cut.ts'),
    title: 'Release-cut worktrees',
    origin: 'agent',
    roots: [`${WORKSPACE_ROOT_TOKEN}/papercusp-relcut-*`, `${WORKSPACE_ROOT_TOKEN}/papercup-relcut-*`],
    keep: { kind: 'lease', record: 'a release retention lease (~/.papercusp/release-retention) or a registered worktree', graceHours: 24 },
    maxBytes: AGENT_ROOT_MAX_BYTES,
    enforcers: [{ kind: 'standing-reclaim', via: 'papercusp/packages/operator-core/lib/release-cut-reclaim.ts' }],
    note: 'The scheduled owner collects eligible cuts oldest first, measures their allocated bytes against the 20 GiB cap and reports protected overage. Published, authored, live, leased and named-only worktrees retain their existing guards.',
  },
  {
    id: 'cargo-target-slots',
    acceptance: disposable('papercusp/papercusp-desktop/bin/lib/claim-target-dir.sh', 'papercusp/papercusp-desktop/bin/lib/claim-target-dir.sh'),
    title: 'Private overflow Cargo target slots',
    origin: 'agent',
    roots: ['/mnt/data/cargo-target/.papercusp-target-slots'],
    keep: { kind: 'lease', record: 'a claimant lock, a live reference or a release retention lease', graceHours: 1 },
    maxBytes: AGENT_ROOT_MAX_BYTES,
    enforcers: [
      { kind: 'existing', ref: 'papercusp/papercusp-desktop/bin/lib/claim-target-dir.sh', schedule: 'every desktop launch', sourceSha256: '7ff1ac08f1dbc5c80e1149caf27d9ebbea09e8bc4052733afcdd69c2c9fa1fdd' },
      { kind: 'standing-reclaim', via: 'papercusp/papercusp-desktop/bin/reap-private-target-slots.sh', sourceSha256: '45737910e89b2154dfbc6d0cc83ba190a1f53433a79cfde167bef7b69d3a9416' },
    ],
    note: 'The native owner eagerly removes every eligible dead private slot, oldest first; a 20 GiB cap receipt counts retained live/leased/recent roots and interrupted deletions. Protected overage is reported, never permission to bypass the owner guards.',
  },
  {
    id: 'repo-scratch',
    acceptance: disposable(STANDING_OWNER, STANDING_OWNER),
    title: 'In-tree agent scratch, tmp and tool caches under a checkout’s .papercusp',
    origin: 'agent',
    roots: [
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/scratch`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/tmp`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/vitest-tmp`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/tsx-*`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/node-compile-cache`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/spawn-results`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/evidence`,
      `${WORKSPACE_ROOT_TOKEN}/*/.papercusp/artifacts`,
    ],
    keep: AGENT_DEFAULT_RULE,
    enforcers: [{ kind: 'standing-reclaim' }],
    note: 'Entries with an open file or a running process cwd inside are skipped. The rest of a checkout’s .papercusp is harness state (blueprint, memory, state, dependency generations) and stays under source-checkouts.',
  },
  {
    id: 'agent-evidence',
    acceptance: disposable(STANDING_OWNER, STANDING_OWNER),
    title: 'Evidence, test-evidence and artifact bundles under ~/.papercusp',
    origin: 'agent',
    roots: ['~/.papercusp/evidence', '~/.papercusp/test-evidence', '~/.papercusp/artifacts'],
    keep: AGENT_DEFAULT_RULE,
    enforcers: [{ kind: 'standing-reclaim' }],
    note: 'Evidence an open work item still needs is pinned (P-006), not kept by a longer class bound.',
  },
  {
    id: 'papercusp-home-run-dirs',
    acceptance: disposable(STANDING_OWNER, STANDING_OWNER),
    title: 'Per-run agent output at the top of ~/.papercusp (plan-item, work-item or date-stamped names)',
    origin: 'agent',
    roots: [...HOME_RUN_DIR_PATTERNS],
    keep: AGENT_DEFAULT_RULE,
    enforcers: [{ kind: 'standing-reclaim' }],
    note:
      '~/.papercusp itself is mixed state: credentials (gcloud-auth, aws-console-login, marketplace-keys), keys, configs and live stores sit beside run output, and code does not reference all of them. So it is not an expire-by-default parent; run output is matched by its naming convention instead, and names that look like a backup, key, credential or login never match.',
  },
  {
    id: 'papercusp-home-release-dirs',
    acceptance: unresolved('Release work dirs may contain retained evidence/source; writer-owned disposable children are not yet proven.', 'papercusp/apps/operator/lib/release/workspace-host-release-cut-cli.ts:workspaceHostCutPaths'),
    title: 'Workspace-host release-cut work dirs at the top of ~/.papercusp',
    origin: 'agent',
    roots: ['~/.papercusp/wh-release-*'],
    keep: { kind: 'review', reason: 'release-cut work dirs; the release tool exports their evidence before the rebuildable parts may go' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'workspace-db-dumps',
    acceptance: disposable(STANDING_OWNER, 'papercusp/packages/backup/src/hook.ts:runPreSnapshotHook'),
    title: 'Per-workspace embedded Postgres dumps',
    origin: 'agent',
    roots: ['~/.papercusp-workspaces/*/db-dumps'],
    keep: { kind: 'newest', keep: 1 },
    enforcers: [{ kind: 'standing-reclaim' }],
  },
  {
    id: 'workspace-restores',
    acceptance: unresolved('Restore copies require native restore/promotion guards; app snapshot writer scope is not qualified.', 'papercusp/packages/backup/src/workspace-backup.ts:restoreToClone', 'papercusp/packages/backup/src/restored-clone-cleanup.ts:sweepRestoredClones'),
    title: 'Restore staging dirs and app snapshots in a workspace',
    origin: 'agent',
    roots: ['~/.papercusp-workspaces/*/.restored', '~/.papercusp-workspaces/*/.papercusp/apps-snap-*'],
    keep: { kind: 'keep', reason: 'mixed restore/app snapshot roots; use the restore owner liveness and promotion proofs, never generic parent expiry' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'unregistered-workspaces',
    acceptance: unresolved('Registry absence does not prove disposable contents; live DB/product descendants stay protected.', 'papercusp/packages/operator-core/lib/workspace-registry.ts', STANDING_OWNER),
    title: 'Workspace roots no longer in the workspace registry',
    origin: 'agent',
    roots: ['~/.papercusp-workspaces/*'],
    keep: { kind: 'keep', reason: 'mixed workspace parent; registry absence cannot authorize deleting live database or product descendants' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'offload-work-copies',
    acceptance: disposable(STANDING_OWNER, STANDING_OWNER),
    title: 'Per-work-item copies moved to /mnt/data/offload',
    origin: 'agent',
    roots: [
      '/mnt/data/offload/re:^(wi|WI|ei|EI)-?[0-9].*',
      '/mnt/data/offload/gate-cache-*',
      '/mnt/data/offload/reclaim-quarantine-*',
      '/mnt/data/offload/papercusp-relcut-*',
      '/mnt/data/offload/papercusp-scratch-*',
      '/mnt/data/offload/pub-*',
    ],
    keep: AGENT_DEFAULT_RULE,
    enforcers: [{ kind: 'standing-reclaim' }],
    note: 'Only names that tie an entry to a work item, gate run, release cut or publish run. Every other offload entry is review.',
  },
  // ── Agent-generated, no safe automatic rule yet: report, never delete ───
  {
    id: 'offload-other',
    acceptance: unresolved('Mixed VM disks, ingests and copies; approved VM run copies need writer provenance.', STORAGE_AUTHORITY),
    title: 'Other /mnt/data/offload entries (VM disks, root-disk copy, ingests)',
    origin: 'agent',
    roots: ['/mnt/data/offload'],
    keep: { kind: 'review', reason: 'includes VM disks and data copies that may still be in use' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'mnt-build-infra',
    acceptance: unresolved('Mixed live generations, registries, VM archives and build output.', STORAGE_AUTHORITY),
    title: 'Build, dependency, registry and VM archives on /mnt/data',
    origin: 'agent',
    roots: [
      '/mnt/data/papercusp-bake',
      '/mnt/data/papercusp-dependency-generations',
      '/mnt/data/dependency-generations',
      '/mnt/data/relocated-builds',
      '/mnt/data/papercusp-registry-*',
      '/mnt/data/papercusp-estate-mirror',
      '/mnt/data/rig-vm-archive',
      '/mnt/data/mac-vm-recovery-*',
      '/mnt/data/cargo-target',
    ],
    keep: { kind: 'review', reason: 'each needs its own rule (live generations, registries and VM images are referenced elsewhere)' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'papercusp-backups',
    acceptance: unresolved('Backup index and writer contract are required before any retention change.', STORAGE_AUTHORITY),
    title: 'Workspace backups on the cold tier and retained legacy path',
    origin: 'agent',
    roots: ['/mnt/data/papercusp-backups', '/mnt/cold-a/papercusp-backups'],
    keep: { kind: 'review', reason: 'backups; a newest-N rule needs the backup writer’s own index' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'staging-generations',
    acceptance: unresolved('Live generations and disposable predecessors need the serving-generation owner contract.', STORAGE_AUTHORITY),
    title: 'Staging operator checkout generations',
    origin: 'agent',
    roots: [`${WORKSPACE_ROOT_TOKEN}/papercusp-staging.generations`],
    keep: { kind: 'review', reason: 'the generation :3170 serves must be read before any is deleted' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'vh-other-state',
    acceptance: unresolved('VM base images and approved run copies must be distinguished by their writer.', 'papercusp/libs/generic/verification-harness/src/runner.ts'),
    title: 'Other verification-harness state (VM archives)',
    origin: 'agent',
    roots: ['~/.local/state/verification-harness'],
    keep: { kind: 'review', reason: 'VM archives without a declared owner' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'agent-clones-and-backups',
    acceptance: unresolved('Unrecorded consumers, backups and release copies cannot share a deletion unit.', STORAGE_AUTHORITY),
    title: 'Ad-hoc clones, store backups and retired mirrors',
    origin: 'agent',
    roots: [
      '~/.papercusp-workspaces/clones',
      '~/.papercusp-workspaces/*/.papercusp/*/hyperbee.*',
      '~/.papercusp/pot-git/*/*.retired-*',
      '~/.papercusp-lane-a-fed',
      '~/.papercusp-fedval',
      '~/papercusp-release*',
      '~/papercusp-*.deb',
      '~/backup-*.tar.gz',
      '/mnt/data/papercusp-repro',
      '~/sheets-clone--*',
      '~/.cache/papercusp',
      '~/.cache/pui-acceptance-root-*',
    ],
    keep: { kind: 'review', reason: 'one-off copies whose consumers are not recorded' },
    enforcers: [{ kind: 'none' }],
  },
  // ── /mnt/backup (WI-6554700010011387) ────────────────────────────────────
  // Protected first: nothing under /mnt/backup is deletable until the owner
  // rules on it (WI-6554700010010388). The agent trees are classified so the
  // census reports their size, but every class here is keep or review.
  {
    id: 'owner-macos-vm',
    acceptance: protectedScope('Owner VM disks, recovery images and backup source are explicitly protected.', STORAGE_AUTHORITY),
    title: 'The macOS VM: OSX-KVM disk, recovery images and the ~/macos-vm backup source',
    origin: 'owner',
    roots: ['/mnt/backup/offload/macos-vm', '~/macos-vm'],
    keep: {
      kind: 'keep',
      reason: 'owner-protected VM and kopia backup source (owner 2026-09-20); ~/macos-vm/OSX-KVM links into /mnt/backup/offload/macos-vm',
    },
    enforcers: [{ kind: 'none' }],
    note: 'A running trial VM may open a copy elsewhere (/mnt/data/offload/macos-vm-*); that does not make this one disposable. Only the owner decides (precedent WI-39360).',
  },
  {
    id: 'db-dumps',
    acceptance: protectedScope('Backup custody belongs to the database backup writer.', STORAGE_AUTHORITY, 'papercusp/packages/backup/src/host-dump-coverage.ts:DEFAULT_HOST_PG_DUMP_DIR'),
    title: 'Papercusp database dumps on the cold-a volume and retained legacy tree',
    origin: 'system',
    roots: ['/mnt/cold-a/Backup/db-dumps', '/mnt/backup/db-dumps'],
    keep: { kind: 'keep', reason: 'the db-backup job writes and rotates these; it is the only writer' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'backup-offload-other',
    acceptance: unresolved('Offload copies include symlink targets and audit inputs with unresolved consumers.', STORAGE_AUTHORITY),
    title: 'Other /mnt/backup/offload entries (home-dir copies, audit inputs)',
    origin: 'agent',
    roots: ['/mnt/backup/offload'],
    keep: { kind: 'review', reason: 'offloads with symlinks pointing back into / and /mnt/data; consumers must be vetted per entry' },
    enforcers: [{ kind: 'none' }],
  },
  {
    id: 'backup-agent-trees',
    acceptance: unresolved('Evidence/targets await the explicit backup-tree owner ruling; not an R5 exclusion.', 'work-item:WI-6554700010010388', STORAGE_AUTHORITY),
    title: 'Agent build, test and evidence trees on /mnt/backup',
    origin: 'agent',
    roots: [
      '/mnt/backup/cloud-e2e-*',
      '/mnt/backup/p012-*',
      '/mnt/backup/pui-*',
      '/mnt/backup/portable-server-*',
      '/mnt/backup/customer-terminal-native-target.*',
      '/mnt/backup/woe-native-cargo-*',
      '/mnt/backup/papercusp-lint-as-committed-*',
      '/mnt/backup/papercusp-agent-evidence',
      '/mnt/backup/papercusp-verification',
    ],
    keep: {
      kind: 'review',
      reason: 'some are evidence for open work items or targets of live symlinks; deletion awaits the owner ruling on WI-6554700010010388',
    },
    enforcers: [{ kind: 'none' }],
  },
];

/** Materialize the policy against the host's configured checkout root. */
export function retentionPolicyForWorkspaceRoot(
  workspaceRootPattern = hostWorkspaceRootPattern(),
): readonly RetentionClass[] {
  const root = workspaceRootPattern.trim().replace(/\/+$/, '') || '/';
  const replacement = root === '/' ? '' : root;
  return BASE_RETENTION_POLICY.map((cls) => {
    const roots = cls.roots.map((pattern) => pattern.replaceAll(WORKSPACE_ROOT_TOKEN, replacement));
    const materialized = roots === cls.roots ? cls : { ...cls, roots };
    return materialized.origin === 'agent' && (materialized.keep.kind === 'max-age' || materialized.keep.kind === 'newest')
      ? { ...materialized, maxBytes: AGENT_ROOT_MAX_BYTES } : materialized;
  });
}

/** Keep the ceilings alongside the existing policy, rather than maintaining a
 * second root registry. Owners of native/lease classes enforce their own limits. */
export const RETENTION_POLICY: readonly RetentionClass[] = retentionPolicyForWorkspaceRoot();

/** Enumerate every declared root and non-path store, including mixed and
 * protected classes. Metadata does not grant deletion or attest runtime caps. */
export function retentionAcceptancePopulation(policy: readonly RetentionClass[] = RETENTION_POLICY) {
  return policy.flatMap((cls) => [
    ...cls.roots.map((scope) => ({ classId: cls.id, scopeKind: 'root' as const, scope, acceptance: cls.acceptance })),
    ...(cls.stores ?? []).map((scope) => ({ classId: cls.id, scopeKind: 'store' as const, scope, acceptance: cls.acceptance })),
  ]);
}

/** Acceptance is fail-closed even when the operational policy is structurally
 * valid: an unresolved parent is a non-pass, never an implicit exemption. */
export function validateRetentionAcceptance(policy: readonly RetentionClass[] = RETENTION_POLICY): string[] {
  const problems = validatePolicy(policy);
  for (const cls of policy) {
    const membership = cls.acceptance;
    if (!membership) {
      problems.push(`${cls.id}: missing R5 acceptance partition`);
      continue;
    }
    if (!Array.isArray(membership.provenance) || !membership.provenance.length ||
        membership.provenance.some((ref) => typeof ref !== 'string' || !ref.trim())) {
      problems.push(`${cls.id}: R5 partition requires source/authority provenance`);
    }
    if (membership.kind === 'disposable') {
      const owners = cls.enforcers.flatMap((enforcer) => enforcer.kind === 'existing' ? [enforcer.ref]
        : enforcer.kind === 'standing-reclaim' ? [enforcer.via ?? STANDING_OWNER] : []);
      if (!membership.owner?.trim() || !owners.includes(membership.owner)) {
        problems.push(`${cls.id}: R5 disposable owner must name an enrolled enforcer`);
      }
      if (!Number.isSafeInteger(cls.maxBytes) || (cls.maxBytes ?? 0) <= 0) {
        problems.push(`${cls.id}: R5 disposable root requires a finite allocated-byte cap`);
      }
      if (cls.origin !== 'agent' || cls.keep.kind === 'keep' || cls.keep.kind === 'review') {
        problems.push(`${cls.id}: R5 disposable scope lacks an agent deletion rule`);
      }
    } else if (membership.kind === 'protected' || membership.kind === 'unresolved') {
      if (!membership.reason?.trim()) problems.push(`${cls.id}: R5 partition requires a reason`);
      if (isDeletableRule(cls.keep)) problems.push(`${cls.id}: R5 ${membership.kind} parent cannot authorize deletion`);
      if (membership.kind === 'unresolved') problems.push(`${cls.id}: unresolved R5 scope: ${membership.reason}`);
    } else {
      problems.push(`${cls.id}: invalid R5 acceptance partition`);
    }
  }
  return problems;
}

// ── Matching ───────────────────────────────────────────────────────────────

const DELETABLE_KINDS = new Set<KeepRule['kind']>(['max-age', 'newest', 'lease']);

/** True when the keep rule lets an automatic path delete entries of the class. */
export function isDeletableRule(rule: KeepRule): boolean {
  return DELETABLE_KINDS.has(rule.kind);
}

type SegmentMatcher = { score: number; test: (s: string) => boolean };

function segmentMatcher(seg: string): SegmentMatcher {
  if (seg.startsWith('re:')) {
    const re = new RegExp(`^(?:${seg.slice(3)})$`);
    return { score: 2, test: (s) => re.test(s) };
  }
  if (seg === '*') return { score: 0, test: () => true };
  if (seg.includes('*')) {
    const re = new RegExp(`^${seg.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return { score: 1, test: (s) => re.test(s) };
  }
  return { score: 3, test: (s) => s === seg };
}

function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean);
}

function expandHome(pattern: string, home: string): string {
  if (pattern === '~') return home;
  return pattern.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${pattern.slice(2)}` : pattern;
}

interface CompiledRoot {
  classId: string;
  pattern: string;
  segments: SegmentMatcher[];
  score: number;
}

export interface RetentionPinProtection { paths: readonly string[]; expiresAt: string }

/** Protect a pin's descendants and the containing entry, without sibling-prefix matches. */
export { retentionPinProtectsPath };

export interface CompiledPolicy {
  classes: ReadonlyMap<string, RetentionClass>;
  roots: CompiledRoot[];
  stores: Array<{ classId: string; prefix: string }>;
  pins?: readonly RetentionPinProtection[];
}

/** Compile a policy against a home directory (default: the current user's). */
export function compilePolicy(policy: readonly RetentionClass[] = RETENTION_POLICY, home: string = homedir(), pins: readonly RetentionPinProtection[] = []): CompiledPolicy {
  const classes = new Map<string, RetentionClass>();
  const roots: CompiledRoot[] = [];
  const stores: Array<{ classId: string; prefix: string }> = [];
  for (const cls of policy) {
    classes.set(cls.id, cls);
    for (const pattern of cls.roots) {
      const segments = splitPath(expandHome(pattern, home)).map(segmentMatcher);
      // Score: per-segment weight, then depth, so a deeper root always outranks a shallower one.
      const score = segments.length * 1000 + segments.reduce((a, s) => a + s.score, 0);
      roots.push({ classId: cls.id, pattern, segments, score });
    }
    for (const prefix of cls.stores ?? []) stores.push({ classId: cls.id, prefix });
  }
  return { classes, roots, stores, pins };
}

export type Classification =
  | { status: 'class'; classId: string; pattern: string; rootDepth: number }
  | { status: 'conflict'; classIds: string[]; patterns: string[] }
  | { status: 'unmatched' };

/** Classify one path (or a non-path census key like `docker:images`). */
export function classifyPath(path: string, compiled: CompiledPolicy): Classification {
  if (!path.startsWith('/')) {
    const hits = compiled.stores.filter((s) => path.startsWith(s.prefix));
    if (hits.length === 0) return { status: 'unmatched' };
    const best = Math.max(...hits.map((h) => h.prefix.length));
    const top = hits.filter((h) => h.prefix.length === best);
    const ids = [...new Set(top.map((h) => h.classId))];
    return ids.length === 1
      ? { status: 'class', classId: ids[0], pattern: top[0].prefix, rootDepth: 0 }
      : { status: 'conflict', classIds: ids, patterns: top.map((h) => h.prefix) };
  }
  const segs = splitPath(path);
  let bestScore = -1;
  let best: CompiledRoot[] = [];
  for (const root of compiled.roots) {
    if (root.segments.length > segs.length) continue;
    if (!root.segments.every((m, i) => m.test(segs[i]))) continue;
    if (root.score > bestScore) {
      bestScore = root.score;
      best = [root];
    } else if (root.score === bestScore) {
      best.push(root);
    }
  }
  if (best.length === 0) return { status: 'unmatched' };
  const ids = [...new Set(best.map((r) => r.classId))];
  return ids.length === 1
    ? { status: 'class', classId: ids[0], pattern: best[0].pattern, rootDepth: best[0].segments.length }
    : { status: 'conflict', classIds: ids, patterns: best.map((r) => r.pattern) };
}

/** True when some class root lies strictly below `path` (an aggregate such as `/home`). */
export function containsClassRoot(path: string, compiled: CompiledPolicy): boolean {
  const segs = splitPath(path);
  return compiled.roots.some(
    (r) => r.segments.length > segs.length && segs.every((s, i) => r.segments[i].test(s)),
  );
}

/**
 * The ONLY selector a deleter may use: the class whose keep rule allows
 * automatic deletion of `path`, or null. Fails closed on unmatched, conflict,
 * keep, review and native classes, and on the class root itself (a deleter
 * removes entries under a root, never the root).
 */
export function deletionClassFor(path: string, compiled: CompiledPolicy, nowMs = Date.now()): RetentionClass | null {
  if (retentionPinProtectsPath(path, compiled.pins ?? [], nowMs)) return null;
  const c = classifyPath(path, compiled);
  if (c.status !== 'class') return null;
  const cls = compiled.classes.get(c.classId);
  if (!cls || !isDeletableRule(cls.keep)) return null;
  // Non-path store keys are never file-deleted; the root itself is never removed.
  if (!path.startsWith('/') || c.rootDepth >= splitPath(path).length) return null;
  return cls;
}

// ── Census mapping (R-2 verification) ────────────────────────────────────────

export interface CensusConsumerRow {
  consumer: string;
  kind: string;
  bytes: number;
}

export interface CensusMapping {
  /** consumer → class id. */
  mapped: Array<{ consumer: string; classId: string; bytes: number }>;
  /** consumers that only contain class roots (e.g. `/`, `/home`). */
  aggregates: string[];
  unmapped: Array<{ consumer: string; bytes: number }>;
  conflicts: Array<{ consumer: string; classIds: string[]; patterns: string[] }>;
  /** census rows with no path to classify (`unattributed`); reported, not mapped. */
  skipped: string[];
}

/** Map every census consumer to a class (R-2: none unmapped, none conflicting). */
export function mapCensusConsumers(rows: readonly CensusConsumerRow[], compiled: CompiledPolicy): CensusMapping {
  const out: CensusMapping = { mapped: [], aggregates: [], unmapped: [], conflicts: [], skipped: [] };
  for (const row of rows) {
    if (row.kind === 'unattributed') {
      out.skipped.push(row.consumer);
      continue;
    }
    // `files` rows name a directory's loose files as `<dir>/*`.
    const path = row.kind === 'files' && row.consumer.endsWith('/*') ? row.consumer.slice(0, -2) || '/' : row.consumer;
    const c = classifyPath(path, compiled);
    if (c.status === 'class') out.mapped.push({ consumer: row.consumer, classId: c.classId, bytes: row.bytes });
    else if (c.status === 'conflict') out.conflicts.push({ consumer: row.consumer, classIds: c.classIds, patterns: c.patterns });
    else if (path.startsWith('/') && containsClassRoot(path, compiled)) out.aggregates.push(row.consumer);
    else out.unmapped.push({ consumer: row.consumer, bytes: row.bytes });
  }
  return out;
}

// ── Policy validation ─────────────────────────────────────────────────────

/**
 * Structural checks the policy must pass (the unit test asserts an empty
 * result). Returns human-readable problems.
 */
export function validatePolicy(policy: readonly RetentionClass[] = RETENTION_POLICY, home: string = homedir()): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const compiled = compilePolicy(policy, home);
  for (const cls of policy) {
    if (ids.has(cls.id)) problems.push(`${cls.id}: duplicate class id`);
    ids.add(cls.id);
    if (!cls.keep) problems.push(`${cls.id}: no keep rule`);
    if (cls.maxBytes !== undefined && (!Number.isSafeInteger(cls.maxBytes) || cls.maxBytes <= 0 ||
        cls.origin !== 'agent' || !['max-age', 'newest', 'lease', 'native'].includes(cls.keep.kind))) {
      problems.push(`${cls.id}: size cap requires positive safe-integer bytes on an agent age/count/lease/native class`);
    }
    if (cls.roots.length === 0 && (cls.stores ?? []).length === 0) problems.push(`${cls.id}: no roots`);
    if (cls.enforcers.length === 0) problems.push(`${cls.id}: no enforcer entry`);
    for (const enforcer of cls.enforcers) {
      const ref = enforcer.kind === 'existing' ? enforcer.ref : enforcer.kind === 'standing-reclaim' ? enforcer.via : undefined;
      if (ref?.split(' ')[0]?.endsWith('.sh') && !('sourceSha256' in enforcer && /^[a-f0-9]{64}$/.test(enforcer.sourceSha256 ?? ''))) {
        problems.push(`${cls.id}: script enforcer ${ref} has no reviewed source pin`);
      }
    }
    const deletable = isDeletableRule(cls.keep);
    if (cls.origin === 'owner' && cls.keep.kind !== 'keep') problems.push(`${cls.id}: owner data must be keep (D-002)`);
    if (deletable) {
      if (cls.origin !== 'agent') problems.push(`${cls.id}: only agent-generated classes may be deleted automatically`);
      // D-005: a deletable class runs on a schedule — an existing scheduled enforcer or the standing reclaim.
      const scheduled = cls.enforcers.some(
        (e) => e.kind === 'standing-reclaim' || (e.kind === 'existing' && e.schedule.trim().length > 0),
      );
      if (!scheduled) problems.push(`${cls.id}: deletable class has no scheduled enforcer (D-005)`);
      // R-3 (owner 2026-10-15): no agent folder outlives 3 days after its last write; pins cover longer needs.
      if (cls.keep.kind === 'max-age') {
        if (cls.keep.maxAgeHours > AGENT_MAX_AGE_HOURS) {
          problems.push(`${cls.id}: max-age ${cls.keep.maxAgeHours}h exceeds the ${AGENT_MAX_AGE_HOURS}h agent ceiling (R-3)`);
        }
        if (cls.keep.buildDirMaxAgeHours !== undefined && cls.keep.buildDirMaxAgeHours > cls.keep.maxAgeHours) {
          problems.push(`${cls.id}: build-dir bound ${cls.keep.buildDirMaxAgeHours}h exceeds the class bound ${cls.keep.maxAgeHours}h`);
        }
      }
    } else if (cls.keep.kind === 'keep' || cls.keep.kind === 'review') {
      if (cls.enforcers.some((e) => e.kind === 'standing-reclaim' || e.kind === 'existing')) {
        problems.push(`${cls.id}: a ${cls.keep.kind} class must not name a deleter`);
      }
    }
  }
  // No two classes may claim an identical root pattern.
  const seen = new Map<string, string>();
  for (const r of compiled.roots) {
    const key = expandHome(r.pattern, home);
    const prior = seen.get(key);
    if (prior && prior !== r.classId) problems.push(`root ${r.pattern} is claimed by ${prior} and ${r.classId}`);
    seen.set(key, r.classId);
  }
  // A deletable root may never sit under an owner-data root (D-002).
  const ownerRoots = compiled.roots.filter((r) => compiled.classes.get(r.classId)?.origin === 'owner');
  for (const r of compiled.roots) {
    const cls = compiled.classes.get(r.classId);
    if (!cls || !isDeletableRule(cls.keep)) continue;
    const segs = splitPath(expandHome(r.pattern, home));
    for (const o of ownerRoots) {
      const oSegs = splitPath(expandHome(o.pattern, home));
      if (oSegs.length <= segs.length && oSegs.every((s, i) => s === segs[i])) {
        problems.push(`${cls.id}: deletable root ${r.pattern} lies under owner root ${o.pattern}`);
      }
    }
  }
  return problems;
}
