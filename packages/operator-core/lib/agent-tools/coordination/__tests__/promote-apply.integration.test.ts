/**
 * promote-apply.integration.test.ts — the plans:promote HANDLER's APPLY path
 * (apply:true) against the baseline-schema PG.
 *
 * HE-02 / P-010 gap #3 (hive-run-evaluation-2026-06-13 — close the Class-1
 * deterministic gaps the HE-01 audit found). The audit's finding: "plans:promote
 * APPLY path — real wave features minted + inter-wave blocked_by edges — only
 * apply:false PREVIEW is tested (it asserts nothing is created)." This drives the
 * real tool handler end-to-end in apply mode and pins the apply-specific behavior
 * the preview test cannot reach:
 *   - the IMPORT PAYLOAD promote builds carries the realized wave structure: per-
 *     feature `wave` stamps + the inter-wave `blocked_by` edges (applyInterWaveEdges
 *     turns a wave-level `blocked_by` into feature-level edges by title), and no
 *     VAL-* `claims` — inline VAL-* blocks are retired and acceptance lives in the
 *     plan's requirement contract (verification-system-improvements-2026-10-10
 *     P-003, D-008);
 *   - an apply over a plan that still carries an inline VAL-* block is REFUSED
 *     with `val-block-retired` BEFORE any write (no import POST, no plan write);
 *   - the from_items plan items are flipped to `done` (real PG plan content);
 *   - the `## Promoted` block + the `draft → active` frontmatter flip are written
 *     back to the plan (real PG plan content).
 *
 * SCOPE (deliberate, not a silent narrowing): the ACTUAL persistence of the minted
 * rows into harness_features_consolidated + the blocked_by → coord_links edges is
 * the `/features/import` ROUTE's responsibility, exercised against real PG by
 * features-provenance-workspace.integration.test.ts (updateFeatureProvenance) and
 * the route's own resolveBlockedByRefs/cycle logic. promote.ts only POSTs the
 * payload there via loopbackFetch — so this test points INTERNAL_API_BASE at an
 * in-test server that CAPTURES that payload (and returns allocated ids), keeping
 * the import route (its own concern) out of promote's test while still proving
 * promote SENDS exactly what the mint consumes.
 *
 * Same fixture as the other plans tool-suite integration tests: the baseline-schema
 * DB via setupPlanPgFixture() (inject('baselineSchemaDsn')).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type postgres from 'postgres';
import promoteTool from '../tools/promote';
import {
  setupPlanPgFixture,
  seedPlan,
  type PlanPgFixture,
} from '../../plans/__tests__/_pg-tool-fixture';
// plans:promote resolves a papercup-harness plan at the papercup-primary workspace
// (PAPERCUSP_WORKSPACE_ID, flipped from 'default' on 2026-06-16 — WI-148 part-B /
// migration 295). Seed + verify there, not the fixture's generic 'default', or the
// tool's readPlanBySlug looks in the wrong workspace → plan_not_found.
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';

// plans:promote reads the plan at the operator-home scope (no harness arg on the
// tool → resolvePlanScope returns operatorHomeHarnessSlug() / PAPERCUSP_WORKSPACE_ID).
// Seed under that home slug — 'papercusp' post papercup→papercusp migration
// (LEGACY_DEFAULT_HOME_HARNESS flipped 2026-06-20) — not the stale 'papercup'
// literal, or the tool's readPlanBySlug looks in the wrong harness → plan_not_found.
const PARENT_HARNESS = operatorHomeHarnessSlug();
const RUN = Math.random().toString(36).slice(2, 8);
const SLUG = `zzz-promote-apply-${RUN}-2026-06-13`;
// A second plan, identical but for one inline VAL-* block under P-001: the
// retirement refusal's subject.
const VAL_SLUG = `zzz-promote-apply-val-${RUN}-2026-06-13`;
const TARGET = `zzz-promote-apply-target-${RUN}`;
const SLUGS = [SLUG, VAL_SLUG];

function planContent(slug: string, opts: { valBlock?: boolean } = {}): string {
  const valBlock = opts.valBlock
    ? `
  - **[VAL-foundation-001]**
    - **Verify:** \`npm run build\` passes
    - **Evidence:** \`tests/build.test.ts\`
    - **Status:** \`todo\``
    : '';
  return `---
title: Promote Apply Test
slug: ${slug}
created: 2026-06-13
updated: 2026-06-13
status: draft
---

# Promote Apply Test

## Now

**State:** Test fixture.

**Next:** Drive the apply path.

## Phase 3 — Live 2-machine hive-git drill (LIVE-G gate — in-process green != live green)

- **P-001** \`todo\` Foundation work.${valBlock}

## Phase 2 — Preparation

- **P-002** \`todo\` Builds on the foundation.

## Promote

\`\`\`yaml
target_harness: ${TARGET}
waves:
  - id: w1
    features:
      - title: "Foundation feature"
        from_items: [P-001]
  - id: w2
    blocked_by: w1
    features:
      - title: "Dependent feature"
        from_items: [P-002]
\`\`\`
`;
}

interface CapturedImport {
  features: Array<{
    title: string;
    wave?: string;
    blocked_by?: string[];
    claims?: string[];
    source_plan_slug?: string;
    source_plan_item_ids?: string[];
    needs_2_machine_rig?: boolean;
  }>;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;
let server: Server;
let prevApiBase: string | undefined;
const captured: CapturedImport[] = [];
// The single apply is the ACT (run once in beforeAll); each test asserts a facet
// of its outcome — re-running promote would hit already-done items (marked: []).
let applyData: any;

async function seedActivationAudit(slug: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${PAPERCUSP_WORKSPACE_ID}, ${PARENT_HARNESS}, ${slug}, 1, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       1, 1, ${'a'.repeat(64)}, '[]'::jsonb, '[]'::jsonb)
  `;
}

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    // promote reads the source plan from the CALLER's scope (ctxToPlanSourceOpts,
    // EI-21093090220973191), so the ctx workspace must be the one the plans are
    // seeded in; a 'default' ctx reads plan_not_found.
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    principal: { kind: 'agent', slug: 'agent-promote-apply-test', workspaceId: PAPERCUSP_WORKSPACE_ID },
  } as never;
}

async function runPromote(args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const res = (await promoteTool.handler(args as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: Boolean(res.isError) };
}

async function readPlanRow(slug: string): Promise<{ content: string; version: number }> {
  const [row] = await admin<{ content: string; version: number }[]>`
    SELECT content, version FROM harness_shared.harness_plans
     WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS} AND plan_slug = ${slug}
  `;
  return row;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, SLUG, planContent(SLUG));
  await seedActivationAudit(SLUG);
  await seedPlan(
    admin,
    PAPERCUSP_WORKSPACE_ID,
    PARENT_HARNESS,
    VAL_SLUG,
    planContent(VAL_SLUG, { valBlock: true }),
  );
  await seedActivationAudit(VAL_SLUG);

  // In-test stand-in for the /features/import route: capture the payload promote
  // POSTs and return deterministic allocated ids. The real mint + coord_links
  // edges are the route's own integration concern (see the header note).
  server = createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').includes('/features/import')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let parsed: CapturedImport = { features: [] };
        try {
          parsed = JSON.parse(body) as CapturedImport;
        } catch {
          /* leave empty */
        }
        captured.push(parsed);
        const ids = parsed.features.map((_f, i) => `F-PROMO-${i}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ids, inserted: ids.length, updated: 0 }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  prevApiBase = process.env.INTERNAL_API_BASE;
  process.env.INTERNAL_API_BASE = `http://127.0.0.1:${port}`;

  // The ACT: one apply over both waves. Tests below assert facets of this outcome.
  // mark_items is passed explicitly: calling .handler() directly bypasses the zod
  // schema's `.default(true)` (defaults are applied by the dispatch layer, not the
  // raw handler), so an omitted mark_items would read as undefined → no mark step.
  const r = await runPromote({ slug: SLUG, all_waves: true, apply: true, mark_items: true });
  applyData = r.data;
  // Carry the refusal body into the failure message: a bare `true !== false`
  // hides which promote gate refused.
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
}, 120_000);

afterAll(async () => {
  if (prevApiBase === undefined) delete process.env.INTERNAL_API_BASE;
  else process.env.INTERNAL_API_BASE = prevApiBase;
  await new Promise<void>((r) => server?.close(() => r()));
  for (const slug of SLUGS) {
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS} AND plan_slug = ${slug}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_revisions WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS} AND plan_slug = ${slug}`.catch(() => {});
    await admin`DELETE FROM harness_shared.harness_plans WHERE plan_slug = ${slug}`.catch(() => {});
  }
  await admin`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${TARGET}`.catch(() => {});
  await fx.dispose();
});

describe('plans:promote APPLY path (apply:true, all_waves)', () => {
  it('builds an import payload with wave stamps and inter-wave blocked_by edges, and no VAL claims', async () => {
    expect(applyData.ok).toBe(true);
    expect(applyData.mode).toBe('apply');
    expect(applyData.applied.feature_ids).toEqual(['F-PROMO-0', 'F-PROMO-1']);

    // The handler POSTed exactly one import with both waves' features.
    expect(captured).toHaveLength(1);
    const feats = captured[0].features;
    expect(feats).toHaveLength(2);

    const foundation = feats.find((f) => f.title === 'Foundation feature')!;
    const dependent = feats.find((f) => f.title === 'Dependent feature')!;
    expect(foundation).toBeDefined();
    expect(dependent).toBeDefined();

    // Per-feature wave stamps (consolidated.wave drives the deterministic drain).
    expect(foundation.wave).toBe('w1');
    expect(dependent.wave).toBe('w2');

    // Inter-wave ordering: wave w2 `blocked_by: w1` → each w2 feature is
    // blocked_by the w1 features' titles (applyInterWaveEdges). w1 has none.
    expect(dependent.blocked_by).toEqual(['Foundation feature']);
    expect(foundation.blocked_by ?? []).toEqual([]);

    // VAL-* claims are retired (P-003): nothing threads a claim id onto a feature.
    expect(foundation.claims ?? []).toEqual([]);
    expect(dependent.claims ?? []).toEqual([]);

    // Provenance carried through.
    expect(foundation.source_plan_slug).toBe(SLUG);
    expect(foundation.source_plan_item_ids).toEqual(['P-001']);
    expect(dependent.source_plan_item_ids).toEqual(['P-002']);

    // Phase-derived admission floor: the live Phase 3 2-machine leg is tagged,
    // while the Phase 2 item is explicitly untagged. This is the payload seam
    // consumed by POST /features/import, not merely a parser-level assertion.
    expect(foundation.needs_2_machine_rig).toBe(true);
    expect(dependent.needs_2_machine_rig).toBe(false);
  });

  // P-003 (D-008) — the recurrence guard for VAL-* retirement. Inline VAL blocks are
  // no longer stored anywhere, so a block left under a promoted item would be
  // silently dropped if promote accepted it. It must refuse with the typed
  // retirement code, and refuse BEFORE any write: the apply path imports features
  // and rewrites the plan, so a late refusal would fire after real side effects.
  //
  // It drives the REAL handler against a REAL seeded plan and reads the REAL plan
  // row and the captured import stream, so it cannot pass by construction.
  it('refuses an apply over a plan with an inline VAL-* block (val-block-retired) before any write', async () => {
    const importsBefore = captured.length;
    const before = await readPlanRow(VAL_SLUG);
    // Calibration: the fixture really carries the block the gate must catch, so
    // the refusal below is not vacuous.
    expect(before.content).toContain('[VAL-foundation-001]');

    const r = await runPromote({ slug: VAL_SLUG, all_waves: true, apply: true, mark_items: true });
    expect(r.isError).toBe(true);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toBe('val-block-retired');
    expect(r.data.items_with_val_blocks).toEqual(['P-001']);
    expect(r.data.violations).toHaveLength(1);
    expect(r.data.violations[0]).toMatchObject({
      code: 'val-block-retired',
      planItemId: 'P-001',
      sourceValId: 'VAL-foundation-001',
    });

    // Nothing was written: no import POSTed, the plan row is untouched.
    expect(captured.length).toBe(importsBefore);
    const after = await readPlanRow(VAL_SLUG);
    expect(Number(after.version)).toBe(Number(before.version));
    expect(after.content).toBe(before.content);
    expect(after.content).toMatch(/- \*\*P-001\*\* `todo`/);
    expect(after.content).not.toContain('## Promoted');
  });

  it('marks the covered plan items done and writes back the ## Promoted block + draft→active (real PG)', async () => {
    // marked_items reported on the (single) apply result.
    expect((applyData.applied.marked_items as string[]).sort()).toEqual(['P-001', 'P-002']);

    const body = (await readPlanRow(SLUG)).content;
    // Items flipped to done.
    expect(body).toMatch(/- \*\*P-001\*\* `done`/);
    expect(body).toMatch(/- \*\*P-002\*\* `done`/);
    // ## Promoted block stamped with the allocated ids.
    expect(body).toContain('## Promoted');
    expect(body).toContain('F-PROMO-0');
    expect(body).toContain('F-PROMO-1');
    // Draft → active on promote.
    expect(body).toMatch(/^status: active$/m);
    expect(body).not.toMatch(/^status: draft$/m);
  });

  it('records one plan revision for each canonical apply write and keeps the latest snapshot current', async () => {
    const [plan] = await admin<{ content: string; content_hash: string; version: number }[]>`
      SELECT content, content_hash, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID}
         AND harness_slug = ${PARENT_HARNESS}
         AND plan_slug = ${SLUG}
    `;
    // Seed version 1, then plans:promote writes once for marking items and once
    // for the final Promoted/Now/status write-back.
    expect(Number(plan.version)).toBe(3);

    const revisions = await admin<{
      seq: number;
      content_hash: string;
      content_snapshot: string;
    }[]>`
      SELECT seq, content_hash, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID}
         AND harness_slug = ${PARENT_HARNESS}
         AND plan_slug = ${SLUG}
       ORDER BY seq
    `;
    expect(revisions.map((row) => row.seq)).toEqual([1, 2]);
    expect(revisions.every((row) => row.content_snapshot.length > 0)).toBe(true);
    expect(revisions[1].content_hash).toBe(plan.content_hash);
    expect(revisions[1].content_snapshot).toBe(plan.content);
  });
});
