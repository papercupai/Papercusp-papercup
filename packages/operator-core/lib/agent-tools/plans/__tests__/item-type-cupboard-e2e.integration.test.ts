/**
 * R-21 and R-22 (plan-item-types-registry-cupboard-2026-10-20 P-008): the two-pot journey, end to
 * end, on real Postgres and the real Cupboard Worker.
 *
 * Pot A authors one shared item type and two plan types that both reference it, in its OWN
 * workspace registry, and publishes them as three packs through the Worker's publish route. The
 * packs land pending review. Pot B, a DIFFERENT workspace id, installs a plan template that
 * requires one of those plan types: the install is refused while the packs are pending and leaves
 * no rows, then succeeds once an operator approves them, pulling in the plan type and the shared
 * item-type pack. A second template requiring the other plan type reuses the installed item type,
 * so pot B holds one row and one content hash for it (R-22). Pot B then runs the seeded plan to
 * shipped through the real ship gate: a completion audit, an acceptance rubric seeded from the
 * item type's criteria template, an independent critique and grade by agents outside the plan's
 * implementer population, the implementer's recorded verdict and a blind review. No `force`.
 *
 * What is real and what is seeded, stated plainly:
 * - The Worker (apps/operator-public) runs in-process on SQLite D1 with every migration applied.
 *   GitHub is stubbed, so publish pins the stubbed tree. Provider lookup goes through the Worker's
 *   public browse route (`GET /listings?provides_*_type=`), and the installer re-verifies the tree
 *   digest against the listing's pin. The git fetch itself is injected: it writes the published
 *   bytes and lists the same blobs the publisher pinned.
 * - The type-pack planner and applier, the plan-template install path, the registry, the ship gate,
 *   the plan tools, the scorecard writer and the blind-review handler are the production ones.
 * - Automatic report indexing keeps its real PostgreSQL chunk writer, with the maintained
 *   deterministic embedding fixture so this workflow does not depend on an embedding sidecar.
 * - The activation audit is seeded as a row, as the sibling ship tests do: the real one needs the
 *   source conversation's session turns. The acceptance bars it would seed come from the real
 *   seeder (`seedAcceptanceBarsInTransaction`), so the rubric is derived from the item type's
 *   criteria template exactly as activation derives it.
 * - The bar critique plans:start requires is seeded only at its routing hop (a `bar-critique`
 *   consult_state row; the relevance router needs real transcripts). The critic's answer and the
 *   author's close go through the real consult verbs, and plans:start reads them back itself.
 * - The ship gate's verdict is read under `withPinnedPlanTypes`, as the ship door reads it.
 *
 * Also covered: built-in parity (a built-in item type id resolves to the same modules as the legacy
 * deliverable it names) and the unknown-type fail-safe (an item type pot B never installed resolves
 * to the strictest module set and is named, with its install hint, by the activation refusal).
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

// The fixture harness is not in the harness registry, so it has no registered source root; point
// citation resolution at the canonical repo root, as general-plan-ship does. Resolution stays real.
vi.mock('../../../plan-audits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan-audits')>();
  return {
    ...actual,
    repoCitationContextForHarness: (_harnessSlug: unknown, citations?: Parameters<typeof actual.repoCitationContextForHarness>[1]) =>
      actual.repoCitationContextForHarness(null, citations),
  };
});
vi.mock('../../../search/embed-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../search/embed-backfill')>();
  const [{ deterministicEmbedding }, { EMBEDDER_DIM_SPECS }] = await Promise.all([
    import('../../../../test/_deterministic-embedder'),
    import('@papercusp/memory'),
  ]);
  const profile = EMBEDDER_DIM_SPECS.gemma;
  return {
    ...actual,
    resolveBackfillEmbedder: async () => ({
      mode: 'gemma', profile,
      embed: async (text: string) => deterministicEmbedding(text, profile.targetDims),
    }),
  };
});
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../add-item';
import '../set-status';
import '../set-plan-status';
import '../audit';
import '../start';
import '../get-specs';
import '../set-specs';
import '../bind-spec-evidence';
import '../evaluate-spec-quality';
import blindReviewTool from '../blind-review';
import { emitScorecard } from '../../scorecards/emit';
import { GRADING_INTEGRITY_RUBRIC_REF } from '../../../grading-integrity';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { evaluatePlanAcceptanceGate } from '../../../plan-acceptance-gate';
import { hashPlanContent } from '../content-hash';
import { runWithWorkspace } from '../../../workspace-als';
import { withPinnedPlanTypes } from '../../../plan-types/pins';
import { getRubric, ensureFirstPartyRubricsSeeded, __resetRubricSeedStateForTests } from '../../../rubrics';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';
import { defineTypeDefinition, readRegistryRows, snapshotOf } from '../../../plan-types/authoring';
import { builtinItemTypeId } from '../../../plan-types/builtin-catalog';
import {
  createRegistryVerificationResolver,
  findUnregisteredTypes,
  STRICTEST_MODULES,
  unregisteredTypesRefusal,
} from '../../../plan-types/resolve-verification';
import { resolveVerification, withVerificationResolver } from '../../../plan-verification-profile';
import { readTypePackReceipt, typePackDeclarations } from '../../../cupboard/type-pack';
import { cupboardTypePackDeps, provisionPackRubric } from '../../../cupboard/type-pack-io';
import { coordsFromRow } from '../../../cupboard/resolve-listing-by-kind';
import { installPlanFromCupboard } from '../../../cupboard/install-plan-io';
import { seedAcceptanceBarsInTransaction } from '../../../acceptance-bar-seed';
import { commentWorkItem, createWorkItem } from '../../../work-items';
import { consultCloseCore, consultReplyCore } from '../../../consult/consult-verbs-core';
import { BAR_CRITIQUE_POLICY } from '../plan-start-critique-gate';
import { bm25ScanScoreFallbacks } from '../../../search/lexical/rank';
import type { SpecClauseSql } from '../spec-clauses-store';
import * as fx from '../../../../test/type-pack-fixture';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** Pot A publishes; pot B installs and ships. Two workspace ids, never one. */
const WS_A = `zzz-e2e-pot-a-${RUN}`;
const WS_B = DEFAULT_WORKSPACE_ID;
const HARNESS = `zzz-itcup-${RUN}`;
const NS = `zzz-itcup-${RUN}`;

/** The one item type both plan types reference (R-22). */
const MEMO = `${NS}/sourced-memo`;
const REVIEW_PLAN = `${NS}/review-plan`;
const BRIEF_PLAN = `${NS}/brief-plan`;
/**
 * D-011: each criterion carries its own verification, so the bars it seeds in pot B arrive
 * with a METHOD and a declarative check instead of waiting for a hand amendment. A memo is not
 * code, so its check is the manual instrument: a reader opens the memo, and the proof bound to
 * the bar is that observation.
 */
const MANUAL_CHECK = { kind: 'instrument', params: { instrumentKey: 'none' } };
const MEMO_TEMPLATE = [
  {
    key: 'cites-sources',
    title: 'Cites its sources',
    description: 'Every claim in the memo names the source it rests on.',
    verification: {
      method: 'Read each claim in the memo and confirm it names the source it rests on.',
      check: MANUAL_CHECK,
      replication: 'Open the memo and list each claim beside the source it names.',
    },
  },
  {
    key: 'dated',
    title: 'Dated',
    description: 'The memo states the date its facts were read.',
    verification: {
      method: 'Confirm the memo states the date its facts were read.',
      check: MANUAL_CHECK,
    },
  },
];

/** The two memos the template's items produce; their hashes fingerprint the bound proof. */
const MEMOS: Record<string, string> = {
  'P-001': 'Vendor memo, read 2026-10-21. Pricing: vendor price sheet v4.',
  'P-002': 'Onboarding memo, read 2026-10-21. Steps: onboarding runbook rev 7.',
};

/** The plan author: activates, finishes items, audits, and records the acceptance verdict. */
const AUTHOR = 'su-itcup-author';
/** Outside the plan's implementer population: critiques the rubric. */
const CRITIC = 'su-itcup-rubric-critic';
/** Outside the plan's implementer population: grades the work. */
const GRADER = 'su-itcup-grader';
const BLIND_REVIEWER = 'su-itcup-blind-reviewer';
/** Outside the plan's implementer population: audits the author's spec-quality card. */
const AUDITOR = 'su-itcup-grading-auditor';

const PUBLISHER = { id: 7301, login: 'acme-type-publisher' };
const HEAD = 'c'.repeat(40);

interface WorkerSurface {
  buildApi(): { request(path: string, init: RequestInit, env: unknown): Promise<Response> };
  makeSqliteDb(): { db: unknown; raw: { close(): void } };
  makeEnv(overrides: { DB: unknown }): { env: { DB: unknown } };
  stubGithub(stub: unknown): void;
  setReviewStatus(db: unknown, id: string, status: 'approved' | 'rejected', reason: string | null, now: number): Promise<void>;
}

async function loadWorker(): Promise<WorkerSurface> {
  // Non-literal and absolute, so operator-core's tsc never compiles the Worker sources and Vite
  // resolves the path against this file rather than the project root.
  const src = new URL('../../../../../../apps/operator-public/src/', import.meta.url);
  const load = (path: string) => import(new URL(`${path}.ts`, src).href) as Promise<Record<string, unknown>>;
  const [routes, sqlite, fake, workerDb] = await Promise.all([
    load('routes/index'), load('__tests__/sqlite-d1'), load('__tests__/fake-d1'), load('db'),
  ]);
  const surface = {
    buildApi: routes.buildApi, makeSqliteDb: sqlite.makeSqliteDb, makeEnv: fake.makeEnv,
    stubGithub: fake.stubGithub, setReviewStatus: workerDb.setReviewStatus,
  };
  for (const [name, fn] of Object.entries(surface)) {
    if (typeof fn !== 'function') throw new Error(`apps/operator-public no longer exports ${name}`);
  }
  return surface as unknown as WorkerSurface;
}

let fx_: PlanPgFixture;
let admin: postgres.Sql;
let worker: WorkerSurface;
let api: ReturnType<WorkerSurface['buildApi']>;
let env: { DB: unknown };
let closeD1: () => void;
let scratch: string;
const realFetch = globalThis.fetch;
const savedHome = process.env.PAPERCUSP_HOME;

/** What each published listing ref serves at HEAD: one file and its git blob id. */
const published = new Map<string, { file: string; bytes: string; blob: string }>();

function gitBlobId(bytes: string): string {
  const body = Buffer.from(bytes);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** Publish one listing through POST /listings, GitHub stubbed to serve `file` under its ref at HEAD. */
async function publish(repoId: number, listingRef: string, file: string, bytes: string, extra: Record<string, unknown>) {
  const blob = gitBlobId(bytes);
  published.set(listingRef, { file, bytes, blob });
  worker.stubGithub({
    user: PUBLISHER,
    repo: { id: repoId, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha: HEAD },
    tree: { entries: [{ path: `${listingRef}/${file}`, sha: blob, size: Buffer.byteLength(bytes) }] },
    blobs: { [blob]: { content: Buffer.from(bytes).toString('base64') } },
  });
  const res = await api.request('/listings', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      github_owner: 'acme', github_name: `${listingRef}-repo`, github_url: `https://github.com/acme/${listingRef}-repo`,
      github_repository_id: repoId, title: listingRef, listing_ref: listingRef, ...extra,
    }),
  }, env);
  const body = await res.json() as { id?: string; listing?: Record<string, unknown>; error?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { id: body.id!, listing: body.listing! };
}

/** The Worker as the installer sees it: anonymous GETs routed in-process. */
const workerFetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  return api.request(`${url.pathname}${url.search}`, {}, env);
}) as typeof fetch;

/** Injected git: write the published bytes at the pinned commit and list the blobs the publisher pinned. */
const fetched: Array<{ url: string; sha: string }> = [];
const gitIo = {
  fetchAtSha: async (url: string, dest: string, sha: string) => {
    fetched.push({ url, sha });
    expect(sha, 'the installer must fetch exactly the pinned commit').toBe(HEAD);
    const ref = [...published.keys()].find((candidate) => url.endsWith(`/${candidate}-repo`));
    if (!ref) throw new Error(`no published listing behind ${url}`);
    const entry = published.get(ref)!;
    await fs.mkdir(join(dest, ref), { recursive: true });
    await fs.writeFile(join(dest, ref, entry.file), entry.bytes);
  },
  listTreeBlobs: async (_dir: string, _sha: string, ref: string) => {
    const entry = published.get(ref);
    return entry ? [{ path: `${ref}/${entry.file}`, sha: entry.blob }] : [];
  },
  tmpDir: () => scratch,
};

/** Resolve a plan listing by id through the Worker's detail route, as resolveListingByKind does. */
async function resolvePlanListing(id: string) {
  const res = await api.request(`/listings/${encodeURIComponent(id)}`, {}, env);
  if (!res.ok) return { error: `listing ${id}: HTTP ${res.status}`, status: res.status };
  const row = await res.json() as Record<string, unknown>;
  const coords = coordsFromRow(row);
  return coords ?? { error: `listing ${id} has no coordinates`, status: 422 };
}

function installTemplate(listingId: string) {
  return runWithWorkspace(WS_B, () => installPlanFromCupboard({ listingId, harness: HARNESS }, {
    resolveListing: resolvePlanListing as never,
    gitDeps: {
      cloneRepo: async () => { throw new Error('a pinned template listing is fetched at its sha, never cloned at tip'); },
      fetchAtSha: gitIo.fetchAtSha,
      listTreeBlobs: gitIo.listTreeBlobs,
      tmpDir: gitIo.tmpDir,
    } as never,
    planTypes: {
      sql: admin,
      workspaceId: WS_B,
      installedBy: 'item-type-cupboard-e2e',
      deps: {
        ...cupboardTypePackDeps({ fetch: workerFetch, baseUrl: () => 'http://cupboard.test', ...gitIo }),
        provisionRubric: provisionPackRubric,
      },
    },
  }));
}

function ctx(principal = AUTHOR): never {
  return {
    workspaceId: WS_B,
    harnessSlug: HARNESS,
    runId: 'item-type-cupboard-e2e',
    role: 'su',
    principal: { kind: 'agent', slug: principal, workspaceId: WS_B },
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await runWithWorkspace(WS_B, () => dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {}));
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  let res: Record<string, unknown>;
  if (structured && typeof structured === 'object') res = structured as Record<string, unknown>;
  else {
    const text = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
    try { res = text ? JSON.parse(text) as Record<string, unknown> : { error: d.error ?? null }; } catch { res = { text }; }
  }
  const results = (res as { results?: Record<string, unknown>[] }).results;
  return (Array.isArray(results) && results[0]) || res;
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 1500);
}

/**
 * The ship gate's verdict, read the way the ship door and the plans:get display read it: under
 * the plan's pinned type revisions, which also supply the plan's declared `type:` so an item with
 * no declared deliverable takes the plan type's default item type.
 */
async function gateBlockers(slug: string): Promise<Array<{ code: string; message?: string }>> {
  const verdict = await runWithWorkspace(WS_B, () => withPinnedPlanTypes(
    { workspaceId: WS_B, harnessSlug: HARNESS, planSlug: slug },
    () => evaluatePlanAcceptanceGate(slug, { harnessSlug: HARNESS, collectAllBlockers: true }),
  ));
  return verdict.satisfied ? [] : (verdict.blockers ?? []).map((b) => ({ code: b.code, message: b.message }));
}

/** The template's own requirement: authored complete, so its bar seeds gradable in pot B. */
const TEMPLATE_R1 = {
  intent: { request: 'Write the two memos the plan names.', sourceRefs: ['session_turn:template-author'] },
  acceptance: {
    condition: 'Both memos the plan names exist and are dated.',
    falsifier: 'Either memo is missing, or a memo does not state the date its facts were read.',
    evidencePlane: 'tree',
  },
  verification: {
    method: 'Open both memos and confirm each exists and states the date its facts were read.',
    check: { kind: 'instrument', instrumentKey: 'none' },
  },
};

/** The template pot A publishes: a plan of `planType` whose items take its default item type. */
function templateMarkdown(slug: string, planType: string): string {
  return `---
title: Sourced memos (${planType})
slug: ${slug}
status: draft
type: ${planType}
---

## Goal

Two memos that a reviewer can trace to their sources.

## Requirements

**R-1 — The memos are written.**
\`\`\`requirement
${JSON.stringify(TEMPLATE_R1)}
\`\`\`

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001, P-002 | tree |

## Existing infrastructure reused

\`\`\`reuse
{"searched":[],"reused":[],"newSurfaces":[],"notApplicable":"Memo plan; no code surface."}
\`\`\`

## Third-party libraries

\`\`\`libraries
{"needs":[],"notApplicable":"Memo plan; no library need."}
\`\`\`

## Phase 1

- **P-001** \`todo\` Write the vendor memo.
- **P-002** \`todo\` Write the onboarding memo.
`;
}

beforeAll(async () => {
  fx_ = await setupPlanPgFixture({ isolated: true });
  admin = fx_.admin;
  await registerHarnessProject(admin, WS_B, HARNESS);
  scratch = mkdtempSync(join(tmpdir(), 'item-type-cupboard-e2e-'));
  process.env.PAPERCUSP_HOME = join(scratch, 'home');
  worker = await loadWorker();
  const d1 = worker.makeSqliteDb();
  closeD1 = () => d1.raw.close();
  env = worker.makeEnv({ DB: d1.db }).env;
  api = worker.buildApi();
  __resetRubricSeedStateForTests();
  await runWithWorkspace(WS_B, () => ensureFirstPartyRubricsSeeded());
}, 180_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  closeD1?.();
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS_B} AND harness_slug = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS_B, HARNESS).catch(() => {});
  }
  await fx_?.dispose();
  if (savedHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = savedHome;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('R-21/R-22: a plan ships in pot B with an item type installed from pot A\'s pack', () => {
  const listings = { items: '', reviewPlans: '', briefPlans: '', reviewTemplate: '', briefTemplate: '' };
  const reviewSlug = `${NS}-review-memos`;
  const briefSlug = `${NS}-brief-memos`;

  it('pot A authors the shared item type and two plan types in its own registry and publishes them; the packs land pending', async () => {
    const memo = fx.itemTypeDef(MEMO, { criteriaTemplate: MEMO_TEMPLATE });
    for (const [kind, definition] of [
      ['item-type', memo],
      ['plan-type', fx.planTypeDef(REVIEW_PLAN, [{ id: MEMO, minRevision: 1 }])],
      ['plan-type', fx.planTypeDef(BRIEF_PLAN, [{ id: MEMO, minRevision: 1 }])],
    ] as const) {
      const stored = await defineTypeDefinition(admin, { workspaceId: WS_A, kind, definition, createdBy: 'su-pot-a' });
      expect(stored, brief(stored)).toMatchObject({ ok: true, typeId: definition.id });
    }

    // The packs carry exactly what pot A's registry stores.
    const rows = await readRegistryRows(admin, WS_A);
    const stored = (table: Array<{ type_id: string; definition: unknown }>, id: string) =>
      table.filter((row) => row.type_id === id).at(-1)?.definition;
    const packs = [
      { key: 'items' as const, ref: `${NS}-shared-items`, typePack: { itemTypes: [stored(rows.itemTypeRows, MEMO)] } },
      { key: 'reviewPlans' as const, ref: `${NS}-review-plans`, typePack: { planTypes: [stored(rows.planTypeRows, REVIEW_PLAN)] } },
      { key: 'briefPlans' as const, ref: `${NS}-brief-plans`, typePack: { planTypes: [stored(rows.planTypeRows, BRIEF_PLAN)] } },
    ];
    let repoId = 9301;
    for (const pack of packs) {
      expect(pack.typePack, `pot A's registry must hold what ${pack.ref} ships`).not.toMatchObject({ itemTypes: [undefined] });
      const manifest = { name: pack.ref, version: '1.0.0', kind: 'pack', typePack: pack.typePack };
      // The publish path derives the declarations from the manifest (D-008).
      const declared = typePackDeclarations(manifest.typePack)!;
      const out = await publish(repoId++, pack.ref, 'papercusp.json', JSON.stringify(manifest), {
        listing_kind: 'pack',
        ...(declared.itemTypes.length ? { provides_item_types: declared.itemTypes } : {}),
        ...(declared.planTypes.length ? { provides_plan_types: declared.planTypes } : {}),
      });
      expect(out.listing.review_status, `${pack.ref} declares types, so it waits for review`).toBe('pending');
      listings[pack.key] = out.id;
    }

    for (const [key, slug, planType] of [
      ['reviewTemplate', reviewSlug, REVIEW_PLAN],
      ['briefTemplate', briefSlug, BRIEF_PLAN],
    ] as const) {
      const out = await publish(repoId++, `${slug}-template`, 'plan.md', templateMarkdown(slug, planType), {
        listing_kind: 'plan',
        requires_plan_type: { id: planType, minRevision: 1 },
      });
      // Plan listings are reviewed by policy (REVIEW_POLICY_KINDS). The templates are approved here,
      // so the next test isolates what it checks: the TYPE packs they need are still pending.
      expect(out.listing.review_status, `${slug} template is reviewed like every plan listing`).toBe('pending');
      await worker.setReviewStatus(env.DB, out.id, 'approved', 'template reviewed', Date.now());
      listings[key] = out.id;
    }

    // Pot A's authoring never reached pot B.
    expect(await fx.countTypeRows(admin, WS_B, NS)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    expect(await fx.countTypeRows(admin, WS_A, NS)).toMatchObject({ itemTypes: 1, planTypes: 2 });
  });

  it('pot B\'s template install is refused while the packs are pending, and leaves nothing behind', async () => {
    const result = await installTemplate(listings.reviewTemplate);

    expect(result.ok, brief(result)).toBe(false);
    expect(!result.ok && result.detail, brief(result)).toBe('type_provider_missing');
    expect(await fx.countTypeRows(admin, WS_B, NS)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    const [seeded] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.harness_plans WHERE workspace_id = ${WS_B} AND plan_slug = ${reviewSlug}`;
    expect(seeded!.n, 'a refused install seeds no template').toBe(0);
  });

  it('after approval, installing both templates pulls in both plan types and ONE shared item type', async () => {
    for (const id of [listings.items, listings.reviewPlans, listings.briefPlans]) {
      await worker.setReviewStatus(env.DB, id, 'approved', 'type pack reviewed', Date.now());
    }

    const review = await installTemplate(listings.reviewTemplate);
    expect(review.ok, brief(review)).toBe(true);
    if (!review.ok) return;
    expect(review.result.planType).toMatchObject({ required: { id: REVIEW_PLAN, minRevision: 1 }, resolvedBy: 'listing' });
    expect(review.result.planType!.installed.map((receipt) => receipt.listingId).sort())
      .toEqual([listings.items, listings.reviewPlans].sort());
    expect(review.result.seeded, brief(review.result)).toBe(true);

    const briefInstall = await installTemplate(listings.briefTemplate);
    expect(briefInstall.ok, brief(briefInstall)).toBe(true);
    if (!briefInstall.ok) return;
    // The second plan type resolves the shared item type from the registry: no second item pack.
    expect(briefInstall.result.planType!.installed.map((receipt) => receipt.listingId)).toEqual([listings.briefPlans]);

    // R-22: one registry row and one content hash for the shared item type, sourced from pot A's pack.
    // The content hash is derived from the stored definition (the snapshot carries it), not a column.
    const memoRows = await admin<{ revision: number; origin: string; source_listing_id: string }[]>`
      SELECT revision, origin, source_listing_id FROM harness_shared.plan_item_type_definitions
       WHERE workspace_id = ${WS_B} AND type_id = ${MEMO}`;
    expect(memoRows.map((row) => ({ ...row, revision: Number(row.revision) })), brief(memoRows)).toEqual([
      { revision: 1, origin: 'pack', source_listing_id: listings.items },
    ]);
    expect(await fx.definitionSource(admin, WS_B, 'plan_type_definitions', REVIEW_PLAN))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: listings.reviewPlans }]);
    expect(await fx.definitionSource(admin, WS_B, 'plan_type_definitions', BRIEF_PLAN))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: listings.briefPlans }]);
    expect(await readTypePackReceipt(admin, WS_B, listings.items)).toMatchObject({ listingId: listings.items, commitSha: HEAD });

    // Both plan types resolve their default item to that one definition.
    const registry = snapshotOf(await readRegistryRows(admin, WS_B));
    const resolvedHashes = new Set<string>();
    const resolver = createRegistryVerificationResolver(registry, {
      onResolved: (ref) => { if (ref.kind === 'item-type' && ref.id === MEMO) resolvedHashes.add(ref.contentHash); },
    });
    for (const planType of [REVIEW_PLAN, BRIEF_PLAN]) {
      const verification = withVerificationResolver(resolver, () =>
        resolveVerification({ verificationProfile: 'general', planType } as never, { deliverable: null } as never));
      expect(verification.codeDeliverable, `${planType}'s default item is a non-code memo`).toBe(false);
    }
    expect(resolvedHashes.size, `both plan types must resolve ${MEMO} to one content hash`).toBe(1);
  });

  it('pot B runs the seeded plan to shipped through the real ship gate, without force', async () => {
    // A private table may use a sequential scan. Assert the documented recovery when it
    // occurs; its real search result still feeds this journey, and other warnings still fail.
    const fallbackCountBefore = bm25ScanScoreFallbacks();
    const realWarn = console.warn.bind(console);
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (args.length === 1 && typeof args[0] === 'string'
        && args[0].startsWith('[lexical/rank] bm25_get_current_score() disagreed with the standalone distance ')) {
        expect(args[0]).toContain('no BM25 index scan drove the list; re-ran with the select-list distance');
        expect(args[0]).toMatch(/\(\d+ since boot\)\. BM25_SCAN_SCORE_NOTE\.$/);
        expect(bm25ScanScoreFallbacks()).toBeGreaterThan(fallbackCountBefore);
        return;
      }
      realWarn(...args);
    });
    onTestFinished(() => warn.mockRestore());

    const slug = reviewSlug;
    const [plan] = await admin<{ content: string; version: number; title: string; status: string }[]>`
      SELECT content, version, title, status FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS_B} AND plan_slug = ${slug}`;
    expect(plan, `the template install must have seeded ${slug} into pot B`).toBeTruthy();

    // Activation: the audit row (its conversation half needs real session turns) plus the bars the
    // activation audit seeds, through the real seeder, from the plan's requirement and the item
    // type's criteria template.
    await admin`
      INSERT INTO harness_shared.plan_audits
        (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
         activation, audited_plan_revision_id, audited_plan_revision_seq,
         audited_plan_content_hash, items, findings)
      VALUES (${WS_B}, ${HARNESS}, ${slug}, 1, ${AUTHOR}, 'activation',
         ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
         1, 1, ${hashPlanContent(plan!.content)}, '[]'::jsonb, '[]'::jsonb)`;
    const seeded = await runWithWorkspace(WS_B, () => admin.begin((tx) => seedAcceptanceBarsInTransaction({
      workspaceId: WS_B,
      harnessSlug: HARNESS,
      planSlug: slug,
      planContent: plan!.content,
      planTitle: plan!.title,
      planStatus: plan!.status,
      planVersion: Number(plan!.version),
      adoptionEpoch: 1,
      cohort: 'post-epoch' as const,
      // The class the activation audit supplies; a memo plan is general-profile work.
      classRef: 'plan-class-general' as const,
      actorId: AUTHOR,
      now: new Date(),
      executor: tx as unknown as SpecClauseSql,
    })));
    expect(seeded.ok, brief(seeded)).toBe(true);
    if (!seeded.ok) return;

    // Pot B starts the installed plan: each item is promoted to a work item, which is what a
    // bound proof must name.
    // The seeder writes every AUTO-BAR clause as a draft; the author activates them with their
    // BAR pins intact. Spec quality treats those projections as copies of the acceptance bars,
    // not as item contracts, so the author also writes one independent outcome clause per item.
    const drafts = (await call('plans:get-specs', { slug })).specs as Record<string, unknown>[] | undefined;
    expect(drafts?.length, 'the seeder writes one clause per bar per item').toBe(6);
    const ownClauses = [
      { planItemId: 'P-001', behavior: 'The vendor memo names the price sheet version it was read from.' },
      { planItemId: 'P-002', behavior: 'The onboarding memo names the runbook revision it was read from.' },
    ];
    const clausesAccepted = await call('plans:set-specs', {
      slug,
      items: [
        ...drafts!.map((s) => ({
          specId: s.specId, expectedRevision: s.revision, planItemId: s.planItemId, behavior: s.behavior,
          behaviorClass: s.behaviorClass, requiredEvidence: s.requiredEvidence, requiredTestLayers: s.requiredTestLayers,
          mutationRequired: s.mutationRequired, falsifier: s.falsifier, sourceBar: s.sourceBar, lifecycleStatus: 'active',
        })),
        ...ownClauses.map(({ planItemId, behavior }) => ({
          specId: `MEMO-SOURCE-${planItemId}`, expectedRevision: 0, planItemId, behavior,
          behaviorClass: 'non-automated', requiredEvidence: ['a reading of the memo'], requiredTestLayers: [],
          mutationRequired: false, lifecycleStatus: 'active', acceptanceRef: 'author review of the installed template',
          falsifier: { observation: 'The memo omits the version or revision of its source document.', probeMethod: 'Read the memo.' },
        })),
      ],
    });
    expect(clausesAccepted.ok, brief(clausesAccepted)).toBe(true);

    // plans:start needs the exact spec-quality card, emitted by the real writer, and its
    // grading audit settled by an independent auditor.
    const quality = await call('plans:evaluate-spec-quality', { slug, classRef: 'plan-class-general' });
    const qualityFailures = Object.entries((quality.ratings ?? {}) as Record<string, { rating?: string; evidence?: string }>)
      .filter(([, r]) => r.rating === 'fail' || r.rating === 'unknown')
      .map(([key, r]) => `${key}=${String(r.rating)}: ${String(r.evidence ?? '').slice(0, 400)}`);
    expect(quality.verdict, qualityFailures.join('\n')).toBe('pass');
    // The audit stamp records the meta rubric's identity at emit time. The meta rubric is a
    // pot's own authored configuration (there is no first-party seed), so pot B holds a minimal
    // one before the card exists, as emit-lapsed-lease.integration.test.ts does.
    await admin`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title,
         status, created, updated, owner, archived, template, template_data, origin)
      VALUES (${WS_B}, ${HARNESS}, ${GRADING_INTEGRITY_RUBRIC_REF}, '', md5(${GRADING_INTEGRITY_RUBRIC_REF}), 1,
              'Grading integrity', 'active', '2026-10-21', '2026-10-21',
              'su-itcup-meta-rubric-author', FALSE, 'rubric',
              ${JSON.stringify({ kind: 'standard', characteristic: 'grading-integrity',
                criteria: [{ key: 'ratings-match-evidence', title: 'Ratings match evidence',
                  model: 'Every rating on the audited card follows from the evidence it cites.',
                  method: 'Re-read each cited rating against the subject it grades.', driftMarkers: 'A pass with no cited evidence.' }],
                ratingScale: ['pass', 'fail', 'unknown'], description: 'Audits one scorecard.' })}::text::jsonb,
              'local')
      ON CONFLICT DO NOTHING`;
    const qualityCard = await runWithWorkspace(WS_B, () => emitScorecard(
      quality.scorecardDraft as never,
      { createdBy: AUTHOR, workspaceId: WS_B },
    )) as { ok?: unknown; issueId?: string; id?: string };
    expect(qualityCard.ok, brief(qualityCard)).toBe(true);
    const qualityCardId = qualityCard.issueId ?? qualityCard.id;
    expect(qualityCardId, brief(qualityCard)).toBeTruthy();
    const [stamped] = await admin<{ audit: { state?: string; metaRubricRef?: string } | null }[]>`
      SELECT payload->'observation'->'gradingAudit' AS audit FROM harness_shared.work_items
       WHERE workspace_id = ${WS_B} AND feature_id = ${qualityCardId!}`;
    if (stamped?.audit?.state === 'pending') {
      const metaRubricRef = stamped.audit.metaRubricRef ?? GRADING_INTEGRITY_RUBRIC_REF;
      const metaRubric = await runWithWorkspace(WS_B, () => getRubric(metaRubricRef));
      expect(metaRubric?.criteria.length, `meta rubric ${metaRubricRef}`).toBeGreaterThan(0);
      const audited = await runWithWorkspace(WS_B, () => emitScorecard(
        {
          rubricRef: metaRubricRef,
          terminal: true,
          subject: { kind: 'scorecard', ref: qualityCardId },
          ratings: Object.fromEntries(metaRubric!.criteria.map((criterion) => [
            criterion.key,
            { rating: 'pass', evidence: `${AUDITOR} re-read every spec-quality rating against the plan's current clauses` },
          ])),
        } as never,
        { createdBy: AUDITOR, workspaceId: WS_B },
      )) as { ok?: unknown };
      expect(audited.ok, brief(audited)).toBe(true);
    }
    // plans:start also needs a closed-answered bar critique of the current contract, answered from
    // a lineage outside the author's. Only the routing hop is seeded (consult:get_feedback's
    // relevance router needs real transcripts); the critic's answer and the author's close go
    // through the real consult verbs, and plans:start reads them back through its own loader.
    const critiqueId = `consult-itcup-${RUN}`;
    await admin`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing)
      VALUES (${WS_B}, ${critiqueId}, ${AUTHOR}, ${CRITIC}, 'awaiting_responder',
              ${`Critique the acceptance bars and clauses of ${slug}.`}, 'proceed', ${slug},
              ${admin.json({ policy: BAR_CRITIQUE_POLICY } as never)})`;
    let consultPostSeq = 0;
    const consultDeps = {
      getSql: () => admin,
      post: async (input: { conversation_id: string; body: string }) => ({
        post: {
          id: 9_000_000 + ++consultPostSeq, thread_id: `thr-${input.conversation_id}`,
          author_id: 'consult', body: input.body, created_ts: new Date().toISOString(),
        },
        delivered: 1,
      }),
      emitReplyEvent: async () => {},
    } as never;
    const critiqueAnswer = await consultReplyCore({
      workspaceId: WS_B, authorId: CRITIC, conversationId: critiqueId, kind: 'answer',
      body: 'Each bar names an observable reading of a memo and each item clause a falsifiable omission; no bar is missing for either item.',
      evidence: [{ session_id: `${CRITIC}-session`, turn_idx: 1, note: 'read plans:get-specs and the acceptance rubric' }],
    }, consultDeps);
    expect((critiqueAnswer as { ok?: unknown }).ok, brief(critiqueAnswer)).toBe(true);
    const critiqueClosed = await consultCloseCore({
      workspaceId: WS_B, authorId: AUTHOR, conversationId: critiqueId, outcome: 'answered',
      answer: 'The critic found the bars and clauses complete; no change.',
    }, consultDeps);
    expect((critiqueClosed as { state?: unknown }).state, brief(critiqueClosed)).toBe('closed_answered');
    const started = await call('plans:start', { slug });
    expect(started.ok, brief(started)).toBe(true);
    const promoted = await admin<{ feature_id: string; source_plan_item_ids: string[] | null }[]>`
      SELECT feature_id, source_plan_item_ids FROM harness_shared.work_items
       WHERE workspace_id = ${WS_B} AND harness_slug = ${HARNESS} AND source_plan_slug = ${slug}`;
    const workItemFor = new Map(promoted.flatMap((row) =>
      (row.source_plan_item_ids ?? []).map((itemId) => [itemId, row.feature_id] as const)));
    expect([...workItemFor.keys()].sort(), brief(promoted)).toEqual(['P-001', 'P-002']);
    const barKeys = new Set(seeded.projections.map((projection) => projection.barKey));
    expect([...barKeys].filter((key) => key.startsWith('T-')).length, 'the criteria template seeds the item-type bars').toBe(MEMO_TEMPLATE.length);

    for (const item of ['P-001', 'P-002']) {
      const res = await call('plans:set-status', { slug, item, status: 'done', note: 'memo written' });
      expect(res.ok, brief(res)).toBe(true);
    }
    // The code-truth audit: the item type's modules are non-code, so generic evidence verifies it.
    const audit = await call('plans:audit', {
      slug,
      phase: 'completion',
      items: ['P-001', 'P-002'].map((itemId) => ({
        itemId,
        verdict: 'implemented',
        citations: [{ kind: 'external', url: `https://example.com/${slug}/${itemId}`, snapshotHash: 'd'.repeat(64) }],
      })),
    });
    expect(audit.ok, brief(audit)).toBe(true);

    // Proof: every bar's check is the manual instrument, so the author binds the reading of
    // each memo to every clause its plan item carries, at the clause's current revision.
    const specs = await call('plans:get-specs', { slug });
    const clauses = (specs.specs ?? []) as { specId: string; revision: number; planItemId: string }[];
    expect(clauses.length, brief(specs)).toBeGreaterThan(0);
    const bound = await call('plans:bind-spec-evidence', {
      slug,
      items: clauses.map((clause) => ({
        workItemId: workItemFor.get(clause.planItemId),
        specId: clause.specId,
        specRevision: clause.revision,
        evidenceKind: 'manual',
        evidenceRef: `memo:${slug}/${clause.planItemId}`,
        sourceFingerprint: createHash('sha256').update(MEMOS[clause.planItemId] ?? '').digest('hex'),
        details: {
          evidencePlane: 'tree',
          observation: MEMOS[clause.planItemId],
          instrument: { none: true, reason: 'A person reads the memo; the bar\'s check is the manual instrument, so no instrument file exists.' },
        },
      })),
    });
    expect(bound.ok, brief(bound)).toBe(true);

    const rubricRef = seeded.rubricSlug;
    const rubric = await runWithWorkspace(WS_B, () => getRubric(rubricRef));
    expect(rubric?.kind, `rubric ${rubricRef}`).toBe('acceptance');

    // Vetting: an independent critique of the CURRENT rubric identity, through a review work item.
    const review = await runWithWorkspace(WS_B, () => createWorkItem({
      kind: 'task',
      harness: HARNESS,
      title: `Rubric vetting: vet acceptance rubric ${rubricRef}`,
      summary: `Vet acceptance rubric ${rubricRef} at criteriaHash ${rubric!.criteriaHash}.`,
      createdBy: AUTHOR,
    } as never));
    const posted = await runWithWorkspace(WS_B, () => commentWorkItem(review.id, `Critique of ${rubricRef}: the template bars are observable; keep them.`, CRITIC, { workspaceId: WS_B, harness: HARNESS }));
    expect(posted, 'the critique must land on the review work item').toBeTruthy();

    // Independent grading through the real scorecard writer.
    // Each rating uses the passing value of its own scale: an acceptance rubric rates
    // healthy | degraded | broken | unknown, and a criterion may carry its own scale.
    const passingOn = (scale: readonly string[]) => {
      const value = scale.includes('pass') ? 'pass' : 'healthy';
      expect(scale, 'the rubric scale must have a passing value').toContain(value);
      return value;
    };
    const ratings = Object.fromEntries(rubric!.criteria.map((criterion) => [criterion.key, {
      rating: passingOn((criterion as { ratingScale?: string[] }).ratingScale ?? rubric!.ratingScale),
      evidence: `${GRADER} checked ${criterion.key} against the cited memos`,
    }]));
    const graded = await runWithWorkspace(WS_B, () => emitScorecard(
      { rubricRef, subject: { kind: 'plan', ref: slug }, ratings } as never,
      { createdBy: GRADER, workspaceId: WS_B },
    ));
    expect((graded as { ok?: unknown }).ok, brief(graded)).toBe(true);
    const gradingId = (graded as { issueId?: string; id?: string }).issueId ?? (graded as { id?: string }).id;

    // The implementer records the acceptance call, adopting the independent card.
    const accepted = await runWithWorkspace(WS_B, () => emitScorecard(
      { rubricRef, subject: { kind: 'plan', ref: slug }, ratings, acceptance: { verdict: 'accept', reasoning: 'independent grade passes every bar', ...(gradingId ? { adoptedRatingsFrom: { scorecardId: gradingId } } : {}) } } as never,
      { createdBy: AUTHOR, workspaceId: WS_B },
    ));
    expect((accepted as { ok?: unknown }).ok, brief(accepted)).toBe(true);

    // A counted blind gap review by an agent that never read the plan.
    const reviewerCtx = {
      log: () => {}, progress: () => {}, metadata: () => {}, emit: () => {},
      signal: new AbortController().signal,
      workspaceId: WS_B,
      principal: { kind: 'agent', slug: BLIND_REVIEWER, workspaceId: WS_B },
      ownerId: BLIND_REVIEWER,
      coordOwnerId: BLIND_REVIEWER,
    } as never;
    const blind = (await runWithWorkspace(WS_B, () => blindReviewTool.handler(
      { harness: HARNESS, slug, op: 'post', outcome: 'conclusive', gaps: [] } as never, reviewerCtx,
    ))) as { content?: Array<{ text: string }> };
    expect(JSON.parse(blind.content?.[0]?.text ?? '{}'), brief(blind)).toMatchObject({ ok: true, counts: true });

    const blockers = await gateBlockers(slug);
    expect(blockers.map((b) => b.code), brief(blockers)).toEqual([]);
    const shipped = await call('plans:set-plan-status', { slug, status: 'shipped' });
    expect(shipped.ok, brief(shipped)).toBe(true);
    const [stored] = await admin<{ status: string; forced_past: unknown }[]>`
      SELECT status, forced_past FROM harness_shared.harness_plans WHERE workspace_id = ${WS_B} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
    expect(stored).toMatchObject({ status: 'shipped', forced_past: null });
  });
});

describe('built-in parity and the unknown-type fail-safe', () => {
  it('a built-in item type id resolves to the same verification as the legacy deliverable it names', async () => {
    const registry = snapshotOf(await readRegistryRows(admin, WS_B));
    const resolver = createRegistryVerificationResolver(registry);
    for (const kind of ['code', 'doc'] as const) {
      for (const profile of ['coding', 'general'] as const) {
        const legacy = withVerificationResolver(resolver, () =>
          resolveVerification({ verificationProfile: profile }, { deliverable: kind } as never));
        const builtin = withVerificationResolver(resolver, () =>
          resolveVerification({ verificationProfile: profile }, { deliverable: builtinItemTypeId(kind) } as never));
        expect(builtin, `${profile}/${kind}`).toEqual(legacy);
      }
    }
  });

  it('an item type pot B never installed resolves to the strictest set, and activation names how to install it', async () => {
    const registry = snapshotOf(await readRegistryRows(admin, WS_B));
    const resolver = createRegistryVerificationResolver(registry);
    const missing = `${NS}/never-published`;
    const verification = withVerificationResolver(resolver, () =>
      resolveVerification({ verificationProfile: 'general' }, { deliverable: missing } as never));
    expect([...verification.modules].sort()).toEqual([...STRICTEST_MODULES].sort());

    const unregistered = findUnregisteredTypes({ verificationProfile: 'general' } as never, [{ id: 'P-001', deliverable: missing }], registry);
    expect(unregistered).toMatchObject([{ kind: 'item-type', id: missing, itemIds: ['P-001'] }]);
    const refusal = unregisteredTypesRefusal(unregistered);
    expect(refusal).toContain('unregistered_type');
    expect(refusal).toContain(missing);
    expect(refusal).toContain(unregistered[0]!.install);
  });
});
