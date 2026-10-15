/**
 * Unit tests for the promote spawn_child branch
 * (promote-spawn-child-harness-2026-05-31 P-003/P-004/P-006).
 *
 * Pure pieces: seed-plan synthesis (D-002) emits plain Acceptance sub-bullets
 * and NO inline VAL-* block (VAL-* retired, verification-system-improvements-
 * 2026-10-10 P-003), deterministic id minting (D-004 retry idempotency), the
 * child import payload, and the `## Promoted` spawned-child row annotation.
 * Orchestration: executeSpawnChild's step ordering + the D-004 failure model
 * (warnings, never throws; later steps aborted; idempotent retry paths) via
 * stubbed deps.
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsAndStrings } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  childSeedSlug,
  mintChildFeatureIds,
  synthesizeChildSeedPlan,
  synthesizeScaffoldSpec,
  buildChildImportPayload,
  executeSpawnChild,
  describeSpawnStart,
  seedPlanRefusalOf,
  type SpawnChildDeps,
  type SpawnChildOpts,
} from './spawn-child';
import { findValBlocks } from '../plans/val-retirement';
import { activationGateRefusalValue } from '../plans/plan-activation-gate';
import { invalidPlanDependenciesValue } from '../plans/plan-candidate-dependencies';
import { buildPromotedRows } from './tools/promote';
import type { BuiltFeature, SpawnChild } from '../plans/promote-policy';

const DATE = '2026-06-07';

const FEATURES: BuiltFeature[] = [
  {
    title: 'Port the CLI entrypoints',
    acceptance: ['CLI builds in the child repo', 'smoke-run passes'],
    body: 'Move bin/ + the arg parser.',
    from_items: ['P-009'],
    spawn_child_slug: 'my-tool-cli',
  },
  {
    title: 'Wire release automation',
    acceptance: ['tagged release publishes'],
    spawn_child_slug: 'my-tool-cli',
  },
  {
    // No acceptance — must synthesize an item with zero Acceptance sub-bullets, not a broken block.
    title: 'Write the child README',
    spawn_child_slug: 'my-tool-cli',
  },
];

const CHILD: SpawnChild = {
  slug: 'my-tool-cli',
  template: 'node-cli',
  goal: 'Extract the CLI into its own repo + lifecycle',
};

function synth(overrides: Partial<Parameters<typeof synthesizeChildSeedPlan>[0]> = {}) {
  return synthesizeChildSeedPlan({
    childSlug: 'my-tool-cli',
    seedSlug: childSeedSlug('my-tool-cli', DATE),
    goal: CHILD.goal,
    parentPlanSlug: 'parent-plan-2026-06-01',
    parentHarnessSlug: 'papercup',
    waveId: 'extract-cli',
    features: FEATURES,
    date: DATE,
    ...overrides,
  });
}

describe('childSeedSlug / mintChildFeatureIds (D-002 / D-004 determinism)', () => {
  it('seed slug is <child>-seed-<date>', () => {
    expect(childSeedSlug('my-tool-cli', DATE)).toBe('my-tool-cli-seed-2026-06-07');
  });

  it('mints deterministic, padded, FEATURE_ID_RE-valid ids', () => {
    const ids = mintChildFeatureIds('my-tool-cli', 3);
    expect(ids).toEqual(['F-MY-TOOL-CLI-SEED-001', 'F-MY-TOOL-CLI-SEED-002', 'F-MY-TOOL-CLI-SEED-003']);
    // The import route's id gate (features.ts FEATURE_ID_RE).
    const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;
    for (const id of ids) expect(id).toMatch(FEATURE_ID_RE);
    // Deterministic: same input → same ids (retry upserts, never duplicates).
    expect(mintChildFeatureIds('my-tool-cli', 3)).toEqual(ids);
  });
});

describe('synthesizeChildSeedPlan (D-002)', () => {
  it('declares the child-seed template, so the activation gate exempts it (D-038)', () => {
    expect(synth().body).toMatch(/^template: child-seed$/m);
  });

  it('spawn-child.ts is the ONLY source that may introduce the child-seed template (D-038 no-self-serve)', () => {
    // Producer pin: allowChildSeedTemplate is the capability that bypasses the
    // child_seed_template_reserved refusal. Scan non-test source with comments and
    // string literals stripped, so prose that mentions the flag cannot self-match.
    // Stripping is the expensive step, so it runs only on files whose raw text names the
    // flag at all (a superset of the setters); the full strip over every lib file timed out.
    const libRoot = path.resolve(__dirname, '..', '..');
    const files = fs.readdirSync(libRoot, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f) && !f.includes('node_modules'));
    const mentions = files.filter((f) => fs.readFileSync(path.join(libRoot, f), 'utf8').includes('allowChildSeedTemplate'));
    const setters = mentions.filter((f) =>
      /allowChildSeedTemplate\s*:\s*true/.test(stripCommentsAndStrings(fs.readFileSync(path.join(libRoot, f), 'utf8'))),
    );
    // Positive controls: the scan must cover lib and see the real producer and the gate that
    // declares the option, or an empty result is vacuous.
    expect(files.length).toBeGreaterThan(100);
    expect(mentions).toContain(path.join('agent-tools', 'plans', 'with-plan-lock.ts'));
    expect(setters).toEqual([path.join('agent-tools', 'coordination', 'spawn-child.ts')]);
  });

  it('frontmatter carries the seed slug, active status, and the goal as title', () => {
    const seed = synth();
    expect(seed.body).toMatch(/^---\n/);
    expect(seed.body).toContain(`slug: ${seed.seedSlug}`);
    expect(seed.body).toContain('status: active');
    expect(seed.title).toBe(CHILD.goal);
    expect(seed.body).toContain(`title: ${CHILD.goal}`);
    expect(seed.body).toMatch(/^## Now$/m);
  });

  it('falls back to a descriptive title when no goal is declared', () => {
    const seed = synth({ goal: undefined });
    expect(seed.title).toContain('my-tool-cli');
    expect(seed.title).toContain('parent-plan-2026-06-01');
    expect(seed.title).toContain('extract-cli');
  });

  it('synthesizes one P-NNN item per feature, 1:1 and ordered', () => {
    const seed = synth();
    expect(seed.items.map((i) => i.itemId)).toEqual(['P-001', 'P-002', 'P-003']);
    expect(seed.items.map((i) => i.featureIndex)).toEqual([0, 1, 2]);
    expect(seed.body).toMatch(/^- \*\*P-001\*\* `todo` Port the CLI entrypoints$/m);
    expect(seed.body).toMatch(/^- \*\*P-003\*\* `todo` Write the child README$/m);
  });

  it('acceptance entries ride as plain Acceptance sub-bullets — no inline VAL-* block (P-003)', () => {
    const seed = synth();
    // 2 + 1 + 0 acceptance entries → 3 Acceptance sub-bullets, under their items.
    expect(seed.body.match(/^ {2}- \*\*Acceptance:\*\* /gm)).toHaveLength(3);
    expect(seed.body).toMatch(
      /^- \*\*P-001\*\* `todo` Port the CLI entrypoints\n {2}- \*\*Acceptance:\*\* CLI builds in the child repo\n {2}- \*\*Acceptance:\*\* smoke-run passes$/m,
    );
    expect(seed.body).toMatch(
      /^- \*\*P-002\*\* `todo` Wire release automation\n {2}- \*\*Acceptance:\*\* tagged release publishes$/m,
    );
    // The retired surface is absent: plans:promote refuses a body with a VAL
    // block (val-block-retired), so the synthesized seed must never carry one.
    expect(findValBlocks(seed.body)).toEqual([]);
    expect(seed.body).not.toContain('VAL-');
    // Positive control — the detector DOES see a VAL block, so the empty result
    // above is a real absence, not a blind instrument.
    expect(findValBlocks('- **P-001** `todo` x\n  - **[VAL-x-001]**\n    - **Verify:** y')).toHaveLength(1);
    // Items carry no VAL ids any more.
    expect(seed.items[0]).toEqual({ itemId: 'P-001', featureIndex: 0 });
  });

  it('flattens multi-line titles/acceptance into single plan lines', () => {
    const seed = synth({
      features: [{ title: 'A\nmulti-line\ttitle', acceptance: ['line one\nline two'] }],
    });
    expect(seed.body).toMatch(/^- \*\*P-001\*\* `todo` A multi-line title$/m);
    expect(seed.body).toMatch(/^ {2}- \*\*Acceptance:\*\* line one line two$/m);
  });

  it('is deterministic — same input, byte-identical body (D-004 retry)', () => {
    expect(synth().body).toBe(synth().body);
  });

  it('records provenance back to the parent plan + wave', () => {
    const seed = synth();
    expect(seed.body).toContain('## Provenance');
    expect(seed.body).toContain('parent-plan-2026-06-01');
    expect(seed.body).toContain('extract-cli');
  });
});

describe('synthesizeScaffoldSpec', () => {
  it('leads with the goal and lists every feature', () => {
    const spec = synthesizeScaffoldSpec({
      goal: CHILD.goal,
      parentPlanSlug: 'parent-plan-2026-06-01',
      waveId: 'extract-cli',
      features: FEATURES,
    });
    expect(spec).toContain(CHILD.goal!);
    for (const f of FEATURES) expect(spec).toContain(f.title);
  });
});

describe('buildChildImportPayload', () => {
  it('stamps seed-plan provenance and deterministic ids, and carries no VAL claims (P-003)', () => {
    const seed = synth();
    const ids = mintChildFeatureIds('my-tool-cli', FEATURES.length);
    const payload = buildChildImportPayload({
      features: FEATURES,
      seed,
      childFeatureIds: ids,
      parentPlanSlug: 'parent-plan-2026-06-01',
      parentHarnessSlug: 'papercup',
      waveId: 'extract-cli',
    });
    expect(payload).toHaveLength(3);
    expect(payload[0]).toMatchObject({
      id: 'F-MY-TOOL-CLI-SEED-001',
      title: 'Port the CLI entrypoints',
      summary: 'Move bin/ + the arg parser.',
      source_plan_slug: seed.seedSlug,
      source_plan_item_ids: ['P-001'],
    });
    // metadata.source_plan is the DISPATCHER eligibility key (readFrontierFeatures
    // gates on metadata->>'source_plan' ∈ started plans) — must be the SEED slug.
    expect(payload[0].metadata.source_plan).toBe(seed.seedSlug);
    expect(payload[0].metadata.spawned_from).toEqual({
      plan: 'parent-plan-2026-06-01',
      wave: 'extract-cli',
      parent_harness: 'papercup',
    });
    // VAL-* is retired: no feature carries a claims key, acceptance or not
    // (feature 0 HAS acceptance entries — the case the old code turned into claims).
    for (const p of payload) expect(p).not.toHaveProperty('claims');
  });
});

describe('buildPromotedRows — spawned-child annotation (P-004)', () => {
  it('annotates child-routed rows with → spawned child <slug> (plan <seed>)', () => {
    const rows = buildPromotedRows(
      [
        { title: 'Stays in parent', wave: 'w1' },
        {
          title: 'Port the CLI entrypoints',
          wave: 'extract-cli',
          from_items: ['P-009'],
          spawned_child: { slug: 'my-tool-cli', seedSlug: 'my-tool-cli-seed-2026-06-07' },
        },
      ],
      ['F-AUTO-1', 'F-MY-TOOL-CLI-SEED-001'],
    );
    expect(rows[0]).not.toContain('spawned child');
    expect(rows[1]).toContain('→ spawned child my-tool-cli (plan my-tool-cli-seed-2026-06-07)');
    expect(rows[1]).toContain('F-MY-TOOL-CLI-SEED-001');
    expect(rows[1]).toContain('<!-- P-009 -->');
  });
});

// ── executeSpawnChild orchestration ─────────────────────────────────────────

function stubDeps(overrides: Partial<SpawnChildDeps> = {}) {
  const calls: string[] = [];
  const deps: SpawnChildDeps = {
    resolveChild: vi.fn(async () => {
      calls.push('resolveChild');
      return false;
    }),
    scaffold: vi.fn(async () => {
      calls.push('scaffold');
      return { ok: true as const };
    }),
    writeSeedPlan: vi.fn(async () => {
      calls.push('writeSeedPlan');
      return 'created' as const;
    }),
    importFeatures: vi.fn(async (_slug: string, payload: Parameters<SpawnChildDeps['importFeatures']>[1]) => {
      calls.push('importFeatures');
      return { ids: payload.map((p) => p.id), inserted: payload.length, updated: 0 };
    }),
    startPlan: vi.fn(async (): Promise<'started' | 'plan_not_found' | 'axis_retired'> => {
      calls.push('startPlan');
      return 'started';
    }),
    ...overrides,
  };
  return { deps, calls };
}

function opts(overrides: Partial<SpawnChildOpts> = {}): SpawnChildOpts {
  return {
    child: CHILD,
    waveId: 'extract-cli',
    parentSlug: 'papercup',
    parentPlanSlug: 'parent-plan-2026-06-01',
    features: FEATURES,
    date: DATE,
    ...overrides,
  };
}

describe('executeSpawnChild — happy path', () => {
  // The former assertions step (harness_plan_assertions upsert between the seed
  // write and the import) is RETIRED with inline VAL-* (verification-system-
  // improvements-2026-10-10 P-003): the seed mints no VAL ids and the import
  // carries no claims, so nothing sits between the seed write and the import.
  it('runs scaffold → seed plan → import → start, in order', async () => {
    const { deps, calls } = stubDeps();
    const r = await executeSpawnChild(opts(), deps);
    expect(calls).toEqual(['resolveChild', 'scaffold', 'writeSeedPlan', 'importFeatures', 'startPlan']);
    expect(r).not.toHaveProperty('assertions_written');
    expect(r).toMatchObject({
      child_slug: 'my-tool-cli',
      seed_plan_slug: 'my-tool-cli-seed-2026-06-07',
      scaffold: 'created',
      seed_plan: 'created',
      feature_ids: ['F-MY-TOOL-CLI-SEED-001', 'F-MY-TOOL-CLI-SEED-002', 'F-MY-TOOL-CLI-SEED-003'],
      started: true,
      warnings: [],
    });
    // The scaffold was sealed to the caller-derived parent — never the YAML.
    expect(deps.scaffold).toHaveBeenCalledWith('papercup', CHILD, expect.stringContaining('Extract the CLI'));
    // The import landed in the CHILD with the seed plan as source.
    const [slug, payload] = (deps.importFeatures as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(slug).toBe('my-tool-cli');
    expect(payload[0].source_plan_slug).toBe('my-tool-cli-seed-2026-06-07');
  });

  it('skips scaffold when the child already exists (idempotent retry)', async () => {
    const { deps } = stubDeps({ resolveChild: vi.fn(async () => true) });
    const r = await executeSpawnChild(opts(), deps);
    expect(deps.scaffold).not.toHaveBeenCalled();
    expect(r.scaffold).toBe('already_existed');
    expect(r.started).toBe(true);
  });

  it('treats slug_already_in_use + now-resolvable as a lost race and proceeds', async () => {
    let resolved = false;
    const { deps } = stubDeps({
      resolveChild: vi.fn(async () => {
        const r = resolved;
        resolved = true; // second call (post-scaffold-failure re-check) finds it
        return r;
      }),
      scaffold: vi.fn(async () => ({ ok: false as const, error: 'slug_already_in_use' })),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('already_existed');
    expect(r.started).toBe(true);
    expect(r.warnings.some((w) => w.includes('idempotent retry'))).toBe(true);
  });

  it('surfaces the unsupported repo override as a warning, not a silent drop', async () => {
    const { deps } = stubDeps();
    const r = await executeSpawnChild(
      opts({ child: { ...CHILD, repo: 'https://github.com/x/y.git' } }),
      deps,
    );
    expect(r.warnings.some((w) => w.includes('repo override') && w.includes('not yet supported'))).toBe(true);
    expect(r.started).toBe(true); // warning only — the spawn still completes
  });
});

describe('executeSpawnChild — D-004 failure model (warnings, never throws)', () => {
  it('no template + no existing harness → abort before any side effect', async () => {
    const { deps } = stubDeps();
    const r = await executeSpawnChild(opts({ child: { slug: 'my-tool-cli' } }), deps);
    expect(deps.scaffold).not.toHaveBeenCalled();
    expect(deps.writeSeedPlan).not.toHaveBeenCalled();
    expect(r.scaffold).toBe('skipped');
    expect(r.warnings.some((w) => w.includes('template'))).toBe(true);
  });

  it('scaffold failure aborts the remaining steps', async () => {
    const { deps } = stubDeps({
      scaffold: vi.fn(async () => ({ ok: false as const, error: 'template_not_spawnable', detail: 'nope' })),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('failed');
    expect(r.seed_plan).toBe('skipped');
    expect(deps.writeSeedPlan).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('template_not_spawnable'))).toBe(true);
  });

  it('a thrown scaffold is caught — never propagates', async () => {
    const { deps } = stubDeps({
      scaffold: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(executeSpawnChild(opts(), deps)).resolves.toMatchObject({ scaffold: 'failed' });
  });

  it('seed-plan busy leaves the child scaffolded-but-unseeded for retry', async () => {
    const { deps } = stubDeps({ writeSeedPlan: vi.fn(async () => 'busy' as const) });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('created');
    expect(r.seed_plan).toBe('failed');
    expect(deps.importFeatures).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('scaffolded-but-unseeded'))).toBe(true);
  });

  // WI-6554700010008416: withPlanLock returns a refused write as kind:'applied' with
  // the refusal object cast to the value type. A refused seed must fail the seed step
  // and name the refusal — never be reported as a created seed.
  it('a refused seed-plan write fails the seed step and names the refusal code', async () => {
    const { deps } = stubDeps({
      writeSeedPlan: vi.fn(async () => ({
        refused: true as const,
        code: 'conversation_audit_required',
        message: 'plan needs a conversation audit',
      })),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('created');
    expect(r.seed_plan).toBe('failed');
    expect(deps.importFeatures).not.toHaveBeenCalled();
    expect(deps.startPlan).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('conversation_audit_required'))).toBe(true);
  });

  it('seedPlanRefusalOf keeps the code and message of both withPlanLock refusal builders', () => {
    const gate = seedPlanRefusalOf(
      activationGateRefusalValue('seed-x', { satisfied: false, code: 'conversation_audit_required', message: 'm1' } as never),
    );
    expect(gate).toEqual({ refused: true, code: 'conversation_audit_required', message: 'm1' });
    const deps = seedPlanRefusalOf(invalidPlanDependenciesValue('seed-x', { state: 'rejected', diagnostics: [] } as never));
    expect(deps.refused).toBe(true);
    expect(deps.code).toBe('invalid_plan_dependencies');
    expect(deps.message).toContain('seed-x');
    expect(seedPlanRefusalOf(undefined)).toMatchObject({ refused: true, code: 'unknown_refusal' });
  });

  it('import failure aborts the start step with a re-promote warning', async () => {
    const { deps } = stubDeps({
      importFeatures: vi.fn(async () => {
        throw new Error('features_import_failed:404');
      }),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.feature_ids).toEqual([]);
    expect(r.started).toBe(false);
    expect(deps.startPlan).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('feature import failed'))).toBe(true);
  });

  it('an unmatched startPlan row is a warning, not a throw', async () => {
    const { deps } = stubDeps({ startPlan: vi.fn(async () => 'plan_not_found' as const) });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.started).toBe(false);
    expect(r.start).toBe('plan_not_found');
    expect(r.warnings.some((w) => w.includes('plans:start'))).toBe(true);
  });

  // P-071/D-063. The two falsy start outcomes must NOT read alike: this module's
  // warnings mean "re-promote to retry", which is wrong (and was the misleading
  // warning P-071 names) for a refusal no re-promote can change.
  it('a RETIRED axis is a distinct outcome with NO warning — the spawn still succeeded', async () => {
    const { deps } = stubDeps({ startPlan: vi.fn(async () => 'axis_retired' as const) });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.started).toBe(false);
    expect(r.start).toBe('axis_retired');
    expect(r.warnings).toEqual([]);
    // Everything BEFORE the start step still ran — the child is fully seeded.
    expect(r.feature_ids).toHaveLength(3);
  });

  it('a start step that never ran is `skipped`, distinct from a refusal', async () => {
    const { deps } = stubDeps({
      importFeatures: vi.fn(async () => {
        throw new Error('features_import_failed:404');
      }),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.start).toBe('skipped');
    expect(deps.startPlan).not.toHaveBeenCalled();
  });

  it('a throwing startPlan is `failed` + a warning', async () => {
    const { deps } = stubDeps({
      startPlan: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.start).toBe('failed');
    expect(r.started).toBe(false);
    expect(r.warnings.some((w) => w.includes('pg down'))).toBe(true);
  });

  it('describeSpawnStart distinguishes the retirement from every failure', () => {
    expect(describeSpawnStart('started')).toBe(', started');
    expect(describeSpawnStart('axis_retired')).toContain('operational axis is retired');
    expect(describeSpawnStart('axis_retired')).not.toMatch(/NOT started/);
    expect(describeSpawnStart('plan_not_found')).toContain('NOT started');
    expect(describeSpawnStart('failed')).toContain('NOT started');
    expect(describeSpawnStart('skipped')).toBe('');
  });

  it('seed plan already existing is a no-op, not a failure (retry path)', async () => {
    const { deps } = stubDeps({
      resolveChild: vi.fn(async () => true),
      writeSeedPlan: vi.fn(async () => 'already_existed' as const),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.seed_plan).toBe('already_existed');
    expect(r.started).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});
