/**
 * Synthetic superproject for the source-preview tests (plan
 * dhh-source-preview-2026-09-28). Everything lives under a tmpdir: no test ever
 * mutates the shared checkout (house rule — git-sync would commit it).
 *
 * The fixture is shaped like the real monorepo where it matters to the shared
 * selection: the two marker package.json files source-tree-select.sh requires,
 * one real git submodule at libs/papercusp, a tracked node_modules, and one
 * member of each exclusion class the installer cut drops (privacy excludes
 * derived from audit-release-bundle.py, heavy excludes, non-allowlisted tops).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT as SOURCE_ROOT, prepareBgVerifierSource, captureVerifierDependencies } from '../../../scripts/source-preview.mjs';
import type { TestCasePopulationMember } from './testing-case-filter';

// Registration data is deliberately independent of the literal reviewed BAR
// fixture. The source guard compares them; post-run ledger census proves execution.
const R1_SOURCE_FILE = 'packages/operator-core/lib/source-preview-export.test.ts';
const R1_BUILDER_FILE = 'apps/operator/lib/bundle-host-freshness.test.ts';
const R1_ARTIFACT_FILE = 'packages/operator-core/lib/release/operator-artifact.test.ts';
const r1Case = (rowId: string, file: string, testName: string): Readonly<TestCasePopulationMember> =>
  Object.freeze({ rowId, file, testName });
const R1_BOUNDARIES = ['before-build', 'before-publication'] as const;
export const BG_R1_SOURCE_CASES = Object.freeze(R1_BOUNDARIES.flatMap(boundary =>
  (['changed', 'missing', 'added'] as const).map(defect => Object.freeze({ boundary, defect,
    ...r1Case(`bg-r1-source-${defect}-${boundary}`, R1_SOURCE_FILE,
      `bg-r1-source-${defect}-${boundary} rejects ${defect} frozen source ${boundary}`) }))));
export const BG_R1_MEMBER_CASES = Object.freeze(R1_BOUNDARIES.flatMap(boundary =>
  (['omitted', 'added'] as const).map(defect => Object.freeze({ boundary, defect,
    ...r1Case(`bg-r1-member-${defect}-${boundary}`, R1_SOURCE_FILE,
      `bg-r1-member-${defect}-${boundary} rejects ${defect} accepted member ${boundary}`) }))));
export const BG_R1_BUILDER_CASES = Object.freeze(R1_BOUNDARIES.flatMap(boundary =>
  (['builder-configuration', 'toolchain-identity'] as const).map(defect => Object.freeze({ boundary, defect,
    ...r1Case(`bg-r1-${defect}-${boundary}`, R1_BUILDER_FILE,
      `bg-r1-${defect}-${boundary} rejects changed ${defect} ${boundary}`) }))));
export const BG_R1_PARENT_CASES = Object.freeze((['authority-absent', 'authority-unknown',
  'authority-candidate-substitution', 'schema-mismatch', 'digest-mismatch', 'literal-member-added',
  'literal-member-omitted', 'literal-member-changed'] as const).map(defect => Object.freeze({ defect,
    ...r1Case(`bg-r1-parent-${defect}`, R1_ARTIFACT_FILE,
      `bg-r1-parent-${defect} rejects parent ${defect} at actual service boot`) })));
export const BG_R1_COMPILER_CASES = Object.freeze((['source', 'dependency'] as const).map(kind => Object.freeze({ kind,
  ...r1Case(`bg-r1-compiler-${kind}-transient-substitution-restored`, R1_ARTIFACT_FILE,
    `bg-r1-compiler-${kind}-transient-substitution-restored rejects selected ${kind} changed during real compiler consumption then restored before final fence`) })));
export const BG_R1_PARENT_SELECTORS = Object.freeze({
  source: r1Case('source-census', R1_SOURCE_FILE,
    'BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary'),
  members: r1Case('accepted-members', R1_SOURCE_FILE,
    'BG-PREP-EXACT-SELECTION rejects omitted or added accepted manifest members'),
  builder: r1Case('builder-identity', R1_BUILDER_FILE,
    'BG-PREP-EXACT-SELECTION rejects changed builder configuration or toolchain identity'),
  authority: r1Case('parent-authority', R1_ARTIFACT_FILE,
    'BG-PREP-EXACT-SELECTION rejects missing unknown or substituted parent manifest authority at actual service boot'),
  schemaDigest: r1Case('parent-schema-digest', R1_ARTIFACT_FILE,
    'BG-PREP-EXACT-SELECTION rejects parent manifest schema or digest mismatch at actual service boot'),
  literalMembers: r1Case('parent-literal-members', R1_ARTIFACT_FILE,
    'BG-PREP-EXACT-SELECTION rejects added omitted or changed literal parent manifest members at actual service boot'),
});
export const BG_R1_CENSUS_CASE = r1Case('bg-r1-census', R1_SOURCE_FILE,
  'bg-r1-census requires exact predeclared selector and branch population');
export const BG_R1_COMPILER_POSITIVE_CASE = r1Case('bg-r1-compiler-immutable-input-positive-control', R1_ARTIFACT_FILE,
  'bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes');
export const BG_R1_CASE_REGISTRY = Object.freeze([
  ...Object.values(BG_R1_PARENT_SELECTORS), ...BG_R1_SOURCE_CASES, ...BG_R1_MEMBER_CASES,
  ...BG_R1_BUILDER_CASES, ...BG_R1_PARENT_CASES, BG_R1_CENSUS_CASE,
  ...BG_R1_COMPILER_CASES, BG_R1_COMPILER_POSITIVE_CASE,
].map(({ rowId, file, testName }) => r1Case(rowId, file, testName)));

// Reuse R1's selector shape; completed ledger rows establish execution.
export const BG_R4_PARENT_SELECTORS = Object.freeze({
  recursive: r1Case("recursive-inventory", "packages/operator-core/lib/source-preview-export.test.ts",
    "BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation"),
  evidence: r1Case("retained-evidence", "apps/operator/lib/bundle-host-freshness.test.ts",
    "BG-TEARDOWN-RECONCILE preserves source compiler and boot evidence during cleanup"),
  restart: r1Case("restart-cleanup", "packages/operator-core/lib/agent-tools/dev/restart.test.ts",
    "BG-TEARDOWN-RECONCILE refuses stale cleanup of peer and rollback generations"),
  survivors: r1Case("owned-survivors", "packages/operator-core/lib/release/operator-artifact.test.ts",
    "BG-TEARDOWN-RECONCILE refuses terminal sealing with owned survivors"),
  custody: r1Case("parent-custody", "packages/operator-core/lib/source-preview-export.test.ts",
    "BG-TEARDOWN-RECONCILE preserves original parent fire24 owner origin and errors custody"),
  deadline: r1Case("original-deadline", "packages/operator-core/lib/source-preview-export.test.ts",
    "BG-TEARDOWN-RECONCILE refuses terminal success after the predeclared teardown deadline"),
});
export const BG_R4_CUSTODY_CASES = Object.freeze(
  (['parent-fire24', 'owner', 'origin', 'error-history', 'evidence-reference'] as const).flatMap(field =>
    (['delete', 'reset', 'replace', 'rewrite'] as const).map(action => Object.freeze({ field, action,
      ...r1Case(`bg-r4-custody-${field}-${action}`, R1_SOURCE_FILE,
        `bg-r4-custody-${field}-${action} refuses ${action} of original ${field} custody`) }))));
export const BG_R4_TEARDOWN_CASES = Object.freeze(
  (['success', 'failure', 'cancellation', 'timeout', 'interruption-recovery'] as const).flatMap(outcome =>
    (['immediately-before', 'exactly-at', 'after'] as const).map(timing => Object.freeze({ outcome, timing,
      ...r1Case(`bg-r4-teardown-${outcome}-${timing}`, R1_SOURCE_FILE,
        `bg-r4-teardown-${outcome}-${timing} reconciles late descendants on ${outcome} at original teardown deadline ${timing}`) }))));
export const BG_R4_CENSUS_CASE = r1Case('bg-r4-census', R1_SOURCE_FILE,
  'bg-r4-census requires exact predeclared selector and branch population');
export const BG_R4_CASE_REGISTRY = Object.freeze([
  ...Object.values(BG_R4_PARENT_SELECTORS), ...BG_R4_CUSTODY_CASES, ...BG_R4_TEARDOWN_CASES, BG_R4_CENSUS_CASE,
].map(({ rowId, file, testName }) => r1Case(rowId, file, testName)));

const GIT_ID = ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

/**
 * The owner-name literal the audit requires, and the release host README.md links;
 * set on every child env, so neither is ever read from the real box.
 */
export const FIXTURE_ENV = {
  PAPERCUSP_RELEASE_OWNER_NAME: 'Zelda Quuxington',
  PAPERCUSP_RELEASE_OWNER_EMAIL: 'zelda.quuxington@example.invalid',
  PAPERCUSP_UPDATE_BASE_URL: 'https://releases.example.invalid/fixture/',
};

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Test children must execute the fixture/current CLI, without an ambient
  // loader substituting HEAD bytes or redirecting dependency resolution.
  return { ...process.env, ...FIXTURE_ENV, GIT_CONFIG_NOSYSTEM: '1', NODE_OPTIONS: '', NODE_PATH: '', ...extra };
}

export function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', [...GIT_ID, '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', env: childEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

export function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** Eligible runtime docs must survive both public and installer selection (D-009/D-012). */
export const INTERNAL_DOC_CONTENTS = {
  'apps/operator/public/internal/docs/runtime-guide.md': '# Runtime guide\nBuilt-in agent documentation.\n',
  'apps/operator-docs/src/content/docs/agent-insights/runtime-guide.mdx': '# Agent guide\nBuilt-in product documentation.\n',
};

/** Paths the preview must ship (relative to the export root). */
export const SHIPPED = [
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  'apps/operator/package.json',
  'apps/operator/src/index.ts',
  'packages/core/index.ts',
  'docs/architecture.md',
  ...Object.keys(INTERNAL_DOC_CONTENTS),
  'libs/papercusp/package.json',
  'libs/papercusp/libs/db/sql/001-init.sql',
  'libs/papercusp/plugins/markdown-preview/papercusp.json', // a sibling plugin still ships
];

/** Desktop-shell paths only the PUBLIC target ships (P-004); the preview drops the whole shell. */
/** A desktop-shell file that names the fixture owner; it ships in the public cut, scrubbed. */
export const DESKTOP_OWNER_NAMING_FILE = 'papercusp-desktop/bin/rig-notes.sh';
export const PUBLIC_DESKTOP_SHIPPED = ['papercusp-desktop/README.md', 'papercusp-desktop/src-tauri/Cargo.toml'];

/** Desktop-shell paths the public target still leaves out (generated, local state, internal rigs). */
export const PUBLIC_DESKTOP_DROPPED = [
  'papercusp-desktop/src-tauri/env-sidecars/staging/serve.mjs',
  'papercusp-desktop/bin/vm-rig/deploy.sh',
  'papercusp-desktop/bin/deb-hetzner-matrix.sh',
  'papercusp-desktop/.papercusp/state/lock.json',
  'papercusp-desktop/test/release-identity.test.js', // gate's test-files class (P-020 re-export)
];

/** Tracked paths the shared selection must drop, each for a different reason. */
export const DROPPED = [
  'apps/operator/.env', //                 privacy exclude (from the gate)
  'docs/plans/internal-plan.md', //        privacy exclude (from the gate)
  'scratch/notes.md', //                   not on the allowlist
  '.papercusp/pi-sessions/s1.jsonl', //    not on the allowlist + privacy exclude
  'papercusp-desktop/README.md', //        heavy exclude (the Tauri shell)
  'node_modules/leftpad/index.js', //      preview never ships dependencies
  'apps/operator/node_modules/x/index.js', // …at any depth
  'apps/operator/.next/cache.bin', //      heavy exclude
  'libs/papercusp/plugins/gitnexus-bridge/index.ts', // license exclude (GitNexus is noncommercial)
  '.gitmodules', //                        not on the allowlist: names private submodule repos
  'apps/papercusp-publish/src/worker.ts', // closed-layer workspace (open-source-release P-005)
  'apps/the-swarm-site/index.html', //     closed-layer workspace
  'libs/marketplace-public-ui/index.ts', // closed-layer workspace
  'libs/generic/prospect-contract/index.ts', // closed-layer workspace
  'docs/briefs/brief.html', //             internal content
  'docs/evidence/run.json', //             internal content
  'docs/reports/report.md', //             internal content
  'libs/generic/papergrid/grid-core/storybook-static/index.html', // built output
  'packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json', // real session/plan text
  'packages/operator-core/lib/memory/bench/fixtures/prose-gold-set.v1.json', // …and its gold set
  ...PUBLIC_DESKTOP_SHIPPED.filter((p) => p !== 'papercusp-desktop/README.md'), // preview: whole shell
  ...PUBLIC_DESKTOP_DROPPED, //                    …and so every path under it
];

export interface Superproject {
  repo: string;
  subSrc: string;
  commit: string;
  subCommit: string;
}

/** Build the superproject + one submodule; returns the pinned commits. */
export function makeSuperproject(root: string): Superproject {
  const subSrc = join(root, 'core-src');
  mkdirSync(subSrc, { recursive: true });
  git(subSrc, ['init', '-q', '-b', 'main']);
  write(subSrc, 'package.json', JSON.stringify({ name: '@papercusp/core', description: 'core platform libraries' }, null, 2));
  write(subSrc, 'libs/db/sql/001-init.sql', 'CREATE TABLE t (id int);\n');
  write(subSrc, 'plugins/markdown-preview/papercusp.json', '{"name":"markdown-preview"}\n');
  write(subSrc, 'plugins/gitnexus-bridge/index.ts', "spawn('npx', ['gitnexus', 'mcp']);\n");
  git(subSrc, ['add', '-A']);
  git(subSrc, ['commit', '-q', '-m', 'core']);
  const subCommit = git(subSrc, ['rev-parse', 'HEAD']);

  const repo = join(root, 'super');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, 'package.json', JSON.stringify({ name: 'fixture-mono', private: true }, null, 2));
  write(repo, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(repo, 'CLAUDE.md', '# guide\n');
  write(repo, '.gitignore', 'node_modules\n.next\n');
  write(repo, 'apps/operator/package.json', JSON.stringify({ name: 'operator', description: 'the operator host' }, null, 2));
  write(repo, 'apps/operator/src/index.ts', 'export const x = 1;\n');
  write(repo, 'packages/core/index.ts', 'export const y = 2;\n');
  write(repo, 'docs/architecture.md', '# architecture\n');
  for (const [path, body] of Object.entries(INTERNAL_DOC_CONTENTS)) write(repo, path, body);
  write(repo, 'apps/operator/.env', 'DATABASE_URL=postgres://local\n');
  write(repo, 'docs/plans/internal-plan.md', '# internal plan\n');
  write(repo, 'scratch/notes.md', 'scratch\n');
  write(repo, '.papercusp/pi-sessions/s1.jsonl', '{"turn":1}\n');
  write(repo, 'papercusp-desktop/README.md', '# desktop shell\n');
  // A shipped desktop dev script naming the owner: the public export must redact it,
  // because the shell is copied after the shared selection's scrub (P-004/P-013).
  write(repo, DESKTOP_OWNER_NAMING_FILE, `#!/bin/sh\n# rig maintained by ${FIXTURE_ENV.PAPERCUSP_RELEASE_OWNER_NAME}\necho ok\n`);
  write(repo, 'papercusp-desktop/src-tauri/Cargo.toml', '[package]\nname = "papercusp-desktop"\nlicense = "LicenseRef-Sustainable-Use-1.0"\n');
  for (const p of PUBLIC_DESKTOP_DROPPED) write(repo, p, 'internal\n');
  write(repo, 'packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json', '{"entries":[]}\n');
  write(repo, 'packages/operator-core/lib/memory/bench/fixtures/prose-gold-set.v1.json', '{"queries":[]}\n');
  write(repo, 'node_modules/leftpad/index.js', 'module.exports = 1;\n');
  write(repo, 'apps/operator/node_modules/x/index.js', 'module.exports = 2;\n');
  write(repo, 'apps/operator/.next/cache.bin', 'cache\n');
  write(repo, 'apps/papercusp-publish/src/worker.ts', 'export default {};\n');
  write(repo, 'apps/the-swarm-site/index.html', '<html></html>\n');
  write(repo, 'libs/marketplace-public-ui/index.ts', 'export {};\n');
  write(repo, 'libs/generic/prospect-contract/index.ts', 'export {};\n');
  write(repo, 'docs/briefs/brief.html', '<p>brief</p>\n');
  write(repo, 'docs/evidence/run.json', '{}\n');
  write(repo, 'docs/reports/report.md', '# report\n');
  write(repo, 'libs/generic/papergrid/grid-core/storybook-static/index.html', '<html></html>\n');
  git(repo, ['add', '-A', '-f']);
  git(repo, ['submodule', 'add', '-q', subSrc, 'libs/papercusp']);
  git(repo, ['commit', '-q', '-m', 'fixture superproject']);
  return { repo, subSrc, commit: git(repo, ['rev-parse', 'HEAD']), subCommit };
}

export const BG_INPUTS = ['apps/operator/src/index.ts', 'libs/papercusp/package.json'];

/** The same inherited-input fixture serves source and artifact acceptance cases. */
export function makeBgCandidate(base: string) {
  const fixture = makeSuperproject(base);
  git(fixture.repo, ['commit', '--allow-empty', '-qm', 'BG selected child']);
  const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
  const members = { [BG_INPUTS[0]!]: git(fixture.repo, ['rev-parse', `${ref}:${BG_INPUTS[0]}`]),
    [BG_INPUTS[1]!]: git(fixture.subSrc, ['rev-parse', `${fixture.subCommit}:package.json`]) };
  const path = join(base, 'original-parent-manifest.json');
  const bytes = JSON.stringify({ schemaVersion: 1, sourceBlobs: members });
  writeFileSync(path, bytes);
  return { fixture, options: { repo: fixture.repo, ref, dest: join(base, 'selected'), inputs: [...BG_INPUTS],
    acceptedManifest: { path, evidenceRef: 'fixture:original-parent-P002',
      sha256: createHash('sha256').update(bytes).digest('hex'), schemaVersion: 1 as const, members } } };
}

/** Real compiler inputs, retained independently of the suite registering a case. */
export async function makeBgCompilerCandidate(base: string, {
  artifactInputs = false, cliHarness = false, trace = (_stage: string) => {},
} = {}) {
  trace('compiler-fixture:start');
  const c = makeBgCandidate(base);
  git(c.fixture.repo, ['rm', '-rf', '--', 'node_modules', 'apps/operator/node_modules']);
  for (const path of ['papercusp-desktop/bin/lib/pinned-deps.sh', 'apps/operator/bin/release/dependency-generation.sh',
    'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'])
    write(c.fixture.repo, path, readFileSync(join(SOURCE_ROOT, path), 'utf8'));
  if (cliHarness) write(c.fixture.repo, 'scripts/source-preview.mjs',
    `const { runCli } = await import(${JSON.stringify(new URL('../../../scripts/source-preview.mjs', import.meta.url).href)});\nprocess.exitCode = await runCli(process.argv.slice(2));\n`);
  write(c.fixture.repo, BG_INPUTS[0]!, "export { y } from '../../../packages/core/index'; export { default as dep } from 'fixture-dependency';\n");
  git(c.fixture.repo, ['add', '-A']);
  git(c.fixture.repo, ['commit', '-qm', 'BG compiler input custody fixture']);
  c.options.ref = git(c.fixture.repo, ['rev-parse', 'HEAD']);
  c.options.acceptedManifest.members[BG_INPUTS[0]!] = git(c.fixture.repo, ['rev-parse', `${c.options.ref}:${BG_INPUTS[0]}`]);
  if (artifactInputs) {
    c.options.inputs = [BG_INPUTS[0]!, 'packages/core/index.ts'];
    c.options.acceptedManifest.members = Object.fromEntries(c.options.inputs.map(path =>
      [path, git(c.fixture.repo, ['rev-parse', `${c.options.ref}:${path}`])])) as typeof c.options.acceptedManifest.members;
  }
  const manifest = JSON.stringify({ schemaVersion: 1, sourceBlobs: c.options.acceptedManifest.members });
  writeFileSync(c.options.acceptedManifest.path, manifest);
  c.options.acceptedManifest.sha256 = createHash('sha256').update(manifest).digest('hex');
  const prepared = await prepareBgVerifierSource(c.options);
  trace('compiler-fixture:source-ready');
  write(prepared.root, 'node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","main":"index.js"}');
  write(prepared.root, 'node_modules/fixture-dependency/index.js', 'export default 41;\n');
  write(prepared.root, 'node_modules/fixture-package-manager/cli.js', '// fixture package-manager identity\n');
  write(prepared.root, 'node_modules/fixture-compiler/cli.js', '// fixture compiler identity\n');
  const dependencies = captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source });
  trace('compiler-fixture:dependencies-ready');
  return { c, prepared, dependencies };
}
