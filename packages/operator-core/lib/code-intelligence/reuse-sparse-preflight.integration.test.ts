/** P010/D029: size preflight, not a native claim or acceptance receipt. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, registerHarnessProject, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import newPlan from '../agent-tools/plans/new';
import addItem from '../agent-tools/plans/add-item';
import { readPlanBySlug } from '../agent-tools/plans/source';
import * as registry from '../harness-registry';
import { enrichTaskBriefWithReuse, getClaimTimeTaskBrief, readTaskFailureSignals, type TaskBriefDeps } from './task-brief';
import { DEFAULT_PACKER_EFFECTS, packerFacade } from './packer-facade';
import { firstPartyCallers } from './first-party-callers';
import { readEngineeringEvidence } from './engineering-evidence';
import { boundChangeHistoryProviders, fileSymbolNames, readWarmCoChange } from './change-history';
import { stopWarmCoChange } from './warm-cochange-index';
import { cloneBriefProvider } from './clone-brief-provider';
import { buildCloneIndex } from './clone-index';
import { prepareCloneAdvisories } from './clone-advisory';
import { parsePushSnapshot } from './push-snapshot';
import { briefCodePoints, decodeClaimReuseContribution, registeredReuseBriefProviders, REUSE_PROVIDER_POLICY,
  REUSE_PROVIDER_FLAGS, type ReuseProviderContext, type ReuseProviderObservation } from './reuse-brief-providers';
import { nativeCoverageBriefProvider } from './test-coverage-map';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { privateReuseHarnessRegistration, sparseReuseFixtureFiles } from './__fixtures__/reuse-api-journey';
import { collectHarnessSlugArgs } from '../endpoint-route/hive-harness-arg-coverage';

let fx: PlanPgFixture, root: string, privateRoot: string;
const harness = 'r', owner = 'su-sparse-preflight', workItem = 'WI-1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const data = (value: unknown): Record<string, any> => {
  const result = value as { data?: Record<string, any>; content?: { text: string }[] };
  return result.data ?? JSON.parse(result.content![0]!.text);
};
beforeAll(async () => {
  // Audit fixture preconditions before provisioning PG: both actual bodies
  // must qualify under the unchanged clone floor, and fit the real excerpt.
  const files = sparseReuseFixtureFiles(resolve(import.meta.dirname, '../../../..'));
  const index = buildCloneIndex(['a.ts', 'b.ts'].map(path => ({ path, source: files[path]! })));
  expect(index.families('renamed').some(family => family.members.length === 2)).toBe(true);
  expect(files['a.ts']!.length + '// controlled CLI edit\n'.length + '// coordinated revision 3\n'.length).toBeLessThan(360);
  fx = await setupPlanPgFixture({ isolated: true });
  // Match with-test-pg's real runtime workspace width; the shorter default
  // workspace previously understated mandatory context in the native fixture.
  fx.workspaceId = 'test-runtime-00000000-000';
  // Match the native runtime's complete private temp-root width as well as
  // its workspace width; both root references are part of the immutable base.
  privateRoot = await mkdtemp(join(tmpdir(), 'papercusp-test-runtime-'));
  await mkdir(join(privateRoot, 'tmp'));
  root = await mkdtemp(join(privateRoot, 'tmp', 'r-'));
  // Exercise the same request through the real transport scope collector:
  // omitting pot targets the unregistered short slug and fails hive admission.
  const registration = privateReuseHarnessRegistration(fx.workspaceId, harness, root, 'a'.repeat(40));
  expect(collectHarnessSlugArgs(registration, { toolName: 'harness:create' })).toEqual([
    { arg: 'pot', slug: fx.workspaceId },
  ]);
  await registerHarnessProject(fx.admin, fx.workspaceId, harness);
  vi.spyOn(registry, 'loadHarnessRegistry').mockResolvedValue({ projects: [{ slug: harness, path: root }] });
}, 180_000);
afterAll(async () => {
  setFlagOverridesForTest(null); vi.restoreAllMocks();
  await fx?.dispose(); if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
});

it('records a truthful sparse baseline and five actual producer envelopes before native admission', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  const repo = resolve(import.meta.dirname, '../../../..');
  const files = sparseReuseFixtureFiles(repo);
  for (const [path, source] of Object.entries(files)) await writeFile(join(root, path), source);
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  git('init', '-q'); git('config', 'user.name', 'Controlled sparse fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  for (let n = 1; n <= 3; n++) {
    await writeFile(join(root, 'a.ts'), files['a.ts']! + `// r${n}\n`);
    await writeFile(join(root, 'b.ts'), files['b.ts']!.replace(/revision\s*=\s*0/, `revision=${n}`));
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', `revision ${n}`);
  }
  const ctx = { workspaceId: fx.workspaceId, harnessSlug: harness, uiClientId: owner,
    isSuperuser: true, log: vi.fn(), emit: vi.fn(), progress: vi.fn(), metadata: vi.fn() };
  const created = data(await newPlan.handler(newPlan.args.parse({ harness, slug: 'r-2026-10-25',
    title: 'Controlled CLI R20 fixture', content: 'Controlled CLI fixture; no model or live cohort.\n\n## Phase 1 — Fixture\n', force: true }), ctx as never));
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const plan = created.slug as string;
  const added = data(await addItem.handler(addItem.args.parse({ harness, slug: plan,
    phase: 'Phase 1 — Fixture', text: 'Inspect a.ts', importance: 'normal' }), ctx as never)).results[0];
  expect(added.ok, JSON.stringify(added)).toBe(true);
  const persisted = await readPlanBySlug(plan, { workspaceId: fx.workspaceId, harnessSlug: harness });
  expect(persisted).not.toBeNull();
  // Standard disposable SQL fixture records qualify the REAL provenance join.
  // They are explicitly seeded evidence, not a native CLI/session witness.
  const assigned = new Date(Date.now() - 1000), editedAt = new Date();
  const edited = '// CLI\n' + await readFile(join(root, 'a.ts'), 'utf8');
  await writeFile(join(root, 'a.ts'), edited);
  await fx.admin`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,item_kind,status,title,summary,taken_by,taken_at,created_ts,updated_ts)
    VALUES (${fx.workspaceId},${harness},${workItem},'change','open','R','R',${owner},${assigned},1,1)`;
  await fx.admin`INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,session_id,started_at)
    VALUES (${fx.workspaceId},'console',${owner},'controlled-sparse',${assigned})`;
  // The issued writer requires an existing turn; it must never invent one.
  await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id,owner_id,turn_id)
    VALUES (${fx.workspaceId},${owner},'controlled-sparse-preflight')`;
  // P-008: provenance is the prior-work reader over the edit-attribution ledger. Seed one earlier,
  // visible item that edited a.ts's functions (the claimed item itself is current work, not prior).
  const names = fileSymbolNames('a.ts', edited);
  expect(names?.length, 'a.ts declares at least one function').toBeGreaterThan(0);
  await fx.admin`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,item_kind,status,title,summary,created_ts,updated_ts)
    VALUES (${fx.workspaceId},${harness},'WI-prior','bug','done','Earlier a.ts fix','R',1,1)`;
  await fx.admin`INSERT INTO harness_shared.edit_attribution_ledger
    (workspace_id,harness_slug,repo_root,file,agent_id,session_id,work_item_id,ts,symbols)
    VALUES (${fx.workspaceId},${harness},${await realpath(root)},'a.ts',${owner},'controlled-sparse','WI-prior',${editedAt},${names!})`;
  const item = { id: workItem, harness, sourcePlanSlug: plan, sourcePlanItemIds: [added.itemId], payload: { paths: ['a.ts'] } };
  // Cold producer setup is outside this deterministic SIZE preflight. Capture
  // real safe-pack/compiler results; neither a timeout nor a stub shrinks base.
  const packed = await packerFacade('pack', { rootPath: root, include: ['a.ts'], format: 'xml', compress: false }, DEFAULT_PACKER_EFFECTS);
  expect(packed.answer.error, JSON.stringify(packed.answer)).toBeNull();
  const graph = firstPartyCallers({ ts, root, name: 'f', filePath: 'a.ts', paths: ['a.ts'], op: 'callers', limit: 8 });
  expect(graph.error, JSON.stringify(graph)).toBeNull();
  const deps: TaskBriefDeps = { root: async () => root, effects: DEFAULT_PACKER_EFFECTS,
    pack: async () => packed, graph: async () => graph, failures: readTaskFailureSignals, engineering: readEngineeringEvidence };
  const baseline = await getClaimTimeTaskBrief({ workspaceId: fx.workspaceId, workItem: item }, deps);
  expect(baseline?.taskBrief.status).toBe('current');
  const base = baseline!.taskBrief, before = JSON.stringify(base);
  const context: ReuseProviderContext = { surface: 'claim', workspaceId: fx.workspaceId, owner,
    invocation: 'focused-size-only', workItem, plan, planItems: [added.itemId], paths: base.scope.paths,
    sourceVersion: base.sourceFingerprint, commit: base.commit, repository: { ...base.repository!, harness },
    sourceFiles: base.files.map(({ path, sha256 }) => ({ path, sha256 })) };
  const cloneFiles = prepareCloneAdvisories(buildCloneIndex([
    { path: 'a.ts', source: edited }, { path: 'b.ts', source: await readFile(join(root, 'b.ts'), 'utf8') },
  ]));
  const snapshot = parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt: new Date().toISOString(),
    index: { backend: 'first-party-imports', lastCommit: base.commit }, edges: [], clones: { schema: 'clone-advisory-v1', files: cloneFiles } }));
  const sql = registeredReuseBriefProviders().find(p => p.id === 'sql')!;
  const providers = [cloneBriefProvider({ snapshot: () => snapshot }),
    ...boundChangeHistoryProviders({ root: async () => root, harness }), sql, nativeCoverageBriefProvider];
  // The cochange index is resident: its worker builds on the first query and
  // answers 'unknown' while cold (WI-6554700010030353). Warm it first, as the
  // host does, so the capture measures the real producer rather than a cold start.
  for (const deadline = Date.now() + 30_000; (await readWarmCoChange(root, ['a.ts'])).status !== 'measured';) {
    if (Date.now() > deadline) throw new Error('warm cochange index did not become measured within 30s');
    await new Promise(settle => setTimeout(settle, 200));
  }
  const captured = await Promise.all(providers.map(async provider => ({ provider: provider.id,
    result: await provider.read(context, new AbortController().signal) })));
  stopWarmCoChange();
  setFlagOverridesForTest(Object.fromEntries(providers.map(p => [REUSE_PROVIDER_FLAGS[p.id], true])));
  let observations: ReuseProviderObservation[] = [], ledger: string | undefined;
  const response = await enrichTaskBriefWithReuse(base, { workspaceId: fx.workspaceId, workItem: item,
    reuse: { owner, invocation: context.invocation, observe: outcome => {
      observations = outcome.observations; ledger = outcome.ledger;
    } } }, { ...deps, reuse: {
    providers: captured.map(({ provider: id, result }) => ({ id, read: async () => structuredClone(result) })),
  } }, Date.now() + 6000);
  const measurement = { scope: 'focused size preflight; real producers, seeded provenance SQL; no native acceptance',
    coverage: 'actual native provider; absent execution snapshots remain an explicit static fallback',
    baseline: base, captured, observations, response, ledger,
    baseChars: briefCodePoints(before), responseChars: briefCodePoints(JSON.stringify(response)),
    allIssued: observations.every(row => row.status === 'issued') };
  console.info('R20_SPARSE_REAL_PRODUCER_PREFLIGHT', JSON.stringify(measurement));
  expect(captured.map(row => row.provider)).toEqual(['clones', 'cochange', 'provenance', 'sql', 'coverage']);
  for (const { result } of captured) {
    expect(result.status, JSON.stringify(measurement)).toBe('measured');
    expect(result.sourceVersion).toBe(base.sourceFingerprint);
    expect(result.lines.length, JSON.stringify(measurement)).toBeGreaterThan(0);
  }
  expect(JSON.stringify(base)).toBe(before);
  expect({ ...response, graph: { ...response.graph,
    relationships: response.graph.relationships.slice(0, base.graph.relationships.length) } }).toEqual(base);
  expect(observations.map(row => [row.provider, row.status]), JSON.stringify(measurement)).toEqual([
    ['clones', 'issued'], ['cochange', 'issued'], ['provenance', 'issued'], ['sql', 'issued'], ['coverage', 'issued'],
  ]);
  expect(response.graph.relationships.map(wire => decodeClaimReuseContribution(response, wire))).toEqual(
    captured.map(({ provider, result }) => ({ provider, section: REUSE_PROVIDER_POLICY[provider].section,
      sourceVersion: result.sourceVersion, indexVersion: result.indexVersion, text: result.lines.join('\n') })));
  expect(briefCodePoints(JSON.stringify(response))).toBeLessThanOrEqual(3000);
  for (const row of observations) expect(row.chars).toBeLessThanOrEqual(REUSE_PROVIDER_POLICY[row.provider].cap);
  expect(ledger).toBe('recorded');
  const issued = await fx.admin<{ subject: string; chars: number }[]>`SELECT subject, chars
    FROM harness_shared.code_intel_pushes WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}
      AND subject::jsonb->>'invocation' = ${context.invocation}`;
  expect(issued.map(row => JSON.parse(row.subject).provider).sort()).toEqual(captured.map(row => row.provider).sort());
  for (const row of issued) expect(JSON.parse(row.subject)).toMatchObject({
    sourceVersion: base.sourceFingerprint, indexVersion: captured.find(value => value.provider === JSON.parse(row.subject).provider)!.result.indexVersion,
  });
}, 90_000);
