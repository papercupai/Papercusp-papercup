/**
 * plans:new stamps the plan verification profile, plans:add-item declares a deliverable
 * kind, plans:get reads both back, and content writes preserve the stamp
 * (plan-verification-profiles-2026-10-17 P-002, R-4/R-5).
 *
 * Every case goes through the real projected dispatch (`lookupByMcpName` →
 * `dispatchProjectedTool`) against a private (isolated) integration PG, then reads the
 * `harness_plans.verification_profile` / `verification_profile_source` columns directly.
 *
 * Three harnesses cover the R-5 default (D-005):
 *   - HARNESS is registered as a project but has no harness-registry entry, so its blueprint
 *     is unresolvable and an undeclared plan fails safe to coding (basis harness-unresolved).
 *   - CODE_HARNESS has a registry entry whose checkout carries a coding blueprint
 *     (`extends: coding-factory`), so an undeclared plan defaults to coding.
 *   - WORK_HARNESS has a registry entry whose checkout carries the non-coding `work`
 *     blueprint, so an undeclared plan defaults to general.
 * The registry entries are written to the private DB only, so no other test file sees them.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../set-content';
import '../add-item';
import '../get';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { stampNewPlanVerificationProfile } from '../plan-verification-profile-stamp';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-vprofile-${RUN}`;
const CODE_HARNESS = `zzz-vprofile-code-${RUN}`;
const WORK_HARNESS = `zzz-vprofile-work-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;

let fx: PlanPgFixture;
let admin: postgres.Sql;
const tmpDirs: string[] = [];

function ctx(harnessSlug: string): never {
  return {
    workspaceId: WS,
    harnessSlug,
    runId: 'plans-verification-profile-declare',
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

type Dispatched = Awaited<ReturnType<typeof dispatchProjectedTool>>;

async function call(
  tool: string,
  args: Record<string, unknown>,
  harnessSlug = HARNESS,
): Promise<{ d: Dispatched; payload: Record<string, unknown> | null }> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await dispatchProjectedTool(projected!, tool, { harness: harnessSlug, ...args }, ctx(harnessSlug), {});
  const content = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  let payload: Record<string, unknown> | null = null;
  if (structured && typeof structured === 'object') payload = structured as Record<string, unknown>;
  else if (content?.[0]?.text) {
    try {
      payload = JSON.parse(content[0].text) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return { d, payload };
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 700);
}

/** plans:get nests its plan body under a tier-dependent envelope; find the first `key` (depth ≤ 4). */
function findKey(x: unknown, key: string, depth = 0): unknown {
  if (!x || typeof x !== 'object' || depth > 4) return undefined;
  const rec = x as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function profileRow(
  slug: string,
  harnessSlug = HARNESS,
): Promise<{ verification_profile: string | null; verification_profile_source: string | null; content: string } | null> {
  const rows = await admin<{ verification_profile: string | null; verification_profile_source: string | null; content: string }[]>`
    SELECT verification_profile, verification_profile_source, content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${harnessSlug} AND plan_slug = ${slug}
  `;
  return rows[0] ?? null;
}

/** A throwaway checkout whose `.papercusp/blueprint.yaml` extends the named built-in blueprint. */
function checkoutWithBlueprint(extendsId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vprofile-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.papercusp'), { recursive: true });
  writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), `id: t\nextends: ${extendsId}\n`);
  return dir;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  // plans:new resolves the plan workspace from the registered harness. HARNESS gets no
  // registry entry, so its harness default stays unresolvable (fail-safe case).
  await registerHarnessProject(admin, WS, HARNESS);
  await registerHarnessProject(admin, WS, CODE_HARNESS);
  await registerHarnessProject(admin, WS, WORK_HARNESS);
  const codePath = checkoutWithBlueprint('coding-factory');
  const workPath = checkoutWithBlueprint('work');
  await mutateHarnessRegistry(
    (reg) => ({
      ...reg,
      projects: [
        ...reg.projects.filter((p) => p.slug !== CODE_HARNESS && p.slug !== WORK_HARNESS),
        { slug: CODE_HARNESS, path: codePath },
        { slug: WORK_HARNESS, path: workPath },
      ],
    }),
    WS,
  );
}, 180_000);

afterAll(async () => {
  if (admin) {
    for (const h of [HARNESS, CODE_HARNESS, WORK_HARNESS]) await cleanupPlans(admin, WS, h).catch(() => {});
  }
  await fx?.dispose();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('plans:new verification profile (R-4/R-5)', () => {
  it('stamps a declared profile with source=declared and reports it', async () => {
    const slug = 'zzz-vprofile-declared-general-2026-10-20';
    const { d, payload } = await call('plans:new', {
      slug,
      title: 'Vprofile declared general cobalt',
      verificationProfile: 'general',
      force: true,
    });
    expect(payload?.ok, brief({ ok: d.ok, payload, error: d.error })).toBe(true);
    expect(payload?.verificationProfile).toEqual({ profile: 'general', source: 'declared', basis: 'declared' });
    const row = await profileRow(slug);
    expect(row?.verification_profile).toBe('general');
    expect(row?.verification_profile_source).toBe('declared');
  });

  it('defaults an undeclared plan on an unresolvable harness to coding (fail safe)', async () => {
    const slug = 'zzz-vprofile-undeclared-2026-10-20';
    const { d, payload } = await call('plans:new', { slug, title: 'Vprofile undeclared saffron', force: true });
    expect(payload?.ok, brief({ ok: d.ok, payload, error: d.error })).toBe(true);
    expect(payload?.verificationProfile).toEqual({
      profile: 'coding',
      source: 'harness-default',
      basis: 'harness-unresolved',
    });
    const row = await profileRow(slug);
    expect(row?.verification_profile).toBe('coding');
    expect(row?.verification_profile_source).toBe('harness-default');
  });

  it('defaults an undeclared plan in a code harness to coding (basis coding-harness)', async () => {
    const slug = 'zzz-vprofile-undeclared-code-2026-10-20';
    const { d, payload } = await call('plans:new', { slug, title: 'Vprofile code harness teal', force: true }, CODE_HARNESS);
    expect(payload?.ok, brief({ ok: d.ok, payload, error: d.error })).toBe(true);
    expect(payload?.verificationProfile).toEqual({ profile: 'coding', source: 'harness-default', basis: 'coding-harness' });
    const row = await profileRow(slug, CODE_HARNESS);
    expect(row?.verification_profile).toBe('coding');
    expect(row?.verification_profile_source).toBe('harness-default');
  });

  it('defaults an undeclared plan in a non-code harness to general (basis non-coding-harness)', async () => {
    const slug = 'zzz-vprofile-undeclared-work-2026-10-20';
    const { d, payload } = await call('plans:new', { slug, title: 'Vprofile work harness amber', force: true }, WORK_HARNESS);
    expect(payload?.ok, brief({ ok: d.ok, payload, error: d.error })).toBe(true);
    expect(payload?.verificationProfile).toEqual({
      profile: 'general',
      source: 'harness-default',
      basis: 'non-coding-harness',
    });
    const row = await profileRow(slug, WORK_HARNESS);
    expect(row?.verification_profile).toBe('general');
    expect(row?.verification_profile_source).toBe('harness-default');

    const got = await call('plans:get', { slug }, WORK_HARNESS);
    const verification = findKey(got.payload, 'verification') as Record<string, unknown> | undefined;
    expect(verification, brief(got.payload)).toBeTruthy();
    expect(verification?.profile).toBe('general');
    expect(verification?.profileSource).toBe('harness-default');
  });

  it('a declared profile wins over the harness default', async () => {
    const slug = 'zzz-vprofile-declared-in-work-2026-10-20';
    const { d, payload } = await call(
      'plans:new',
      { slug, title: 'Vprofile declared in work harness slate', verificationProfile: 'coding', force: true },
      WORK_HARNESS,
    );
    expect(payload?.ok, brief({ ok: d.ok, payload, error: d.error })).toBe(true);
    expect(payload?.verificationProfile).toEqual({ profile: 'coding', source: 'declared', basis: 'declared' });
    expect((await profileRow(slug, WORK_HARNESS))?.verification_profile).toBe('coding');
  });

  it('refuses an unknown profile at the args schema and creates nothing', async () => {
    const slug = 'zzz-vprofile-bogus-2026-10-20';
    const { d, payload } = await call('plans:new', {
      slug,
      title: 'Vprofile bogus vermilion',
      verificationProfile: 'lenient',
      force: true,
    });
    expect(payload?.ok === true, brief({ ok: d.ok, payload, error: d.error })).toBe(false);
    expect(await profileRow(slug)).toBeNull();
  });

  it('a content write (plans:set-content) preserves the stamped profile', async () => {
    const slug = 'zzz-vprofile-preserved-2026-10-20';
    const created = await call('plans:new', {
      slug,
      title: 'Vprofile preserved umber',
      verificationProfile: 'general',
      force: true,
    });
    expect(created.payload?.ok, brief(created.payload)).toBe(true);
    const before = await profileRow(slug);
    expect(before?.verification_profile).toBe('general');

    const edited = await call('plans:set-content', {
      slug,
      content: `${before!.content.trimEnd()}\n\nAppended by the preservation test.\n`,
    });
    expect(edited.payload?.ok, brief({ ok: edited.d.ok, payload: edited.payload, error: edited.d.error })).toBe(true);

    const after = await profileRow(slug);
    expect(after?.content).toContain('Appended by the preservation test.');
    expect(after?.verification_profile).toBe('general');
    expect(after?.verification_profile_source).toBe('declared');
  });

  it('plans:add-item writes a deliverable override and plans:get shows the checklist', async () => {
    const slug = 'zzz-vprofile-checklist-2026-10-20';
    const created = await call('plans:new', {
      slug,
      title: 'Vprofile checklist celadon',
      verificationProfile: 'general',
      force: true,
    });
    expect(created.payload?.ok, brief(created.payload)).toBe(true);

    const added = await call('plans:add-item', {
      slug,
      phase: 'Phase 1',
      importance: 'normal',
      items: [{ text: 'Ship the exporter', deliverable: 'code' }, { text: 'Write the runbook' }],
    });
    expect(added.payload?.ok, brief({ ok: added.d.ok, payload: added.payload, error: added.d.error })).toBe(true);
    expect((await profileRow(slug))?.content).toContain('Ship the exporter deliverable: code');

    const got = await call('plans:get', { slug });
    const verification = findKey(got.payload, 'verification') as Record<string, unknown> | undefined;
    expect(verification, brief(got.payload)).toBeTruthy();
    expect(verification?.profile).toBe('general');
    expect(verification?.profileSource).toBe('declared');
    expect(verification?.defaultModules).toEqual(['generic-core']);
    const overrides = verification?.overrides as Array<{ id: string; deliverable: string; modules: string[] }>;
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ deliverable: 'code', modules: ['generic-core', 'code'] });
  });

  it('the stamp only fills a NULL: it never overwrites an existing profile', async () => {
    const slug = 'zzz-vprofile-no-overwrite-2026-10-20';
    const created = await call('plans:new', {
      slug,
      title: 'Vprofile no overwrite ochre',
      verificationProfile: 'general',
      force: true,
    });
    expect(created.payload?.ok, brief(created.payload)).toBe(true);

    await admin.begin((tx) =>
      stampNewPlanVerificationProfile(tx as never, { workspaceId: WS, harnessSlug: HARNESS }, slug, {
        profile: 'coding',
        source: 'harness-default',
        basis: 'coding-harness',
      }),
    );

    const row = await profileRow(slug);
    expect(row?.verification_profile).toBe('general');
    expect(row?.verification_profile_source).toBe('declared');
  });
});
