import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  LEARNING_MODEL_EFFORT,
  LEARNING_MODEL_ID,
  LEARNING_MODEL_SPEC,
  isCanonicalLearningModel,
  optionalModelSpec,
} from './model-policy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type ModelBearingEdge = {
  id: string;
  classification: 'canonical-policy' | 'canonical-upstream';
  path: string;
  markers: readonly string[];
};

/**
 * The audited P-001 inventory. `canonical-policy` sites bind the shared policy
 * directly; `canonical-upstream` leaves deliberately receive the model from a
 * caller whose default/config is pinned elsewhere in this same inventory.
 *
 * Keeping the leaves here matters: a central constant can stay green while an
 * actual LLM call quietly stops using it. The marker checks below pin both the
 * policy sites and the final model-bearing call seams.
 */
const MODEL_BEARING_EDGES: readonly ModelBearingEdge[] = [
  {
    id: 'scout.phase-defaults',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/scout/models.ts',
    markers: [
      'DEFAULT_SCOUT_IDEATOR_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_CRITIC_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_RECOMBINE_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_REVISION_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_EXPERIMENT_MODEL = LEARNING_MODEL_SPEC',
    ],
  },
  {
    id: 'scout.ideator',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/ideators.ts',
    markers: ['SCOUT_IDEATOR_MODEL = DEFAULT_SCOUT_IDEATOR_MODEL', 'const model = opts.model ?? SCOUT_IDEATOR_MODEL'],
  },
  {
    id: 'scout.critic',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/critics.ts',
    markers: ['DEFAULT_CRITIC_MODEL = DEFAULT_SCOUT_CRITIC_MODEL', 'model: ctx.model ?? DEFAULT_CRITIC_MODEL'],
  },
  {
    id: 'scout.recombine',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/recombine.ts',
    markers: ['DEFAULT_RECOMBINE_MODEL = DEFAULT_SCOUT_RECOMBINE_MODEL', 'model: opts.model ?? DEFAULT_RECOMBINE_MODEL'],
  },
  {
    id: 'scout.revision',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/revise.ts',
    markers: ['DEFAULT_REVISION_MODEL = DEFAULT_SCOUT_REVISION_MODEL', 'const model = deps.model ?? DEFAULT_REVISION_MODEL'],
  },
  {
    id: 'scout.experiment',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/experiment-generate.ts',
    markers: ['DEFAULT_EXPERIMENT_GEN_MODEL = DEFAULT_SCOUT_EXPERIMENT_MODEL', 'model: opts.model ?? DEFAULT_EXPERIMENT_GEN_MODEL'],
  },
  {
    id: 'scout.capacity-fallback',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/scout/register-scout-action.ts',
    markers: ['DEFAULT_SCOUT_CODEX_FALLBACK_MODEL = LEARNING_MODEL_SPEC'],
  },
  {
    id: 'gym.proposer',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/gym/autoloop-cycle.ts',
    // autoloop-cycle snapshots process.env into `cycleEnv` (`const cycleEnv = { ...process.env }`),
    // so the env override still falls back to the canonical spec; the marker tracks that spelling.
    markers: ['cycleEnv.GYM_LOOP_PROPOSER_MODEL ?? LEARNING_MODEL_SPEC', 'proposerModel: PROPOSER_MODEL'],
  },
  {
    id: 'gym.task-generator',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/gym/task-generator.ts',
    markers: ['model: input.generatorModel'],
  },
  {
    id: 'gym.probe-generator',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/gym/probe-generator.ts',
    markers: ['model: input.generatorModel'],
  },
  {
    id: 'gym.judge-and-rejudge',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/gym/judge-scoring.ts',
    markers: ['model: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'gym.spawned-roles',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/gym/boot-spec.ts',
    markers: [
      'AGENT_ROLES.map((role) => [role, LEARNING_MODEL_SPEC])',
      'cfg.agentModels ?? CANONICAL_GYM_AGENT_MODELS',
    ],
  },
  {
    id: 'iq-battery.solver',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts',
    markers: ['bee: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'iq-battery.judge',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts',
    markers: ['model: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'transfer.distiller',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/transfer/live-deps.ts',
    markers: ['TRANSFER_DISTILL_MODEL = LEARNING_MODEL_SPEC', 'opts.model ?? TRANSFER_DISTILL_MODEL'],
  },
  {
    id: 'transfer.student',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/transfer/live-deps.ts',
    markers: ['TRANSFER_STUDENT_MODEL = LEARNING_MODEL_SPEC', 'opts.model ?? TRANSFER_STUDENT_MODEL'],
  },
  {
    id: 'replay.judge',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/replay/battery.ts',
    markers: ['model: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'regret.replay',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/replay/regret/replay-adapter.ts',
    markers: ['DEFAULT_REGRET_REPLAY_MODEL = LEARNING_MODEL_SPEC', 'options.replayModel ?? DEFAULT_REGRET_REPLAY_MODEL'],
  },
  {
    id: 'prompt-ablation.sut-judge-simulator',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/ablation/runner.ts',
    markers: [
      'sutModel: LEARNING_MODEL_SPEC',
      'judgeModel: LEARNING_MODEL_SPEC',
      'simModel: LEARNING_MODEL_SPEC',
    ],
  },
  {
    id: 'prompt-ablation.replay',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/ablation/replay-leg.ts',
    markers: ['DEFAULT_ABLATION_REPLAY_MODEL = LEARNING_MODEL_SPEC', 'opts.model ?? DEFAULT_ABLATION_REPLAY_MODEL'],
  },
  {
    id: 'improvement.auto-implementation-worker',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/harness/routines/improvement-actions.ts',
    markers: ['spawnModel: LEARNING_MODEL_SPEC'],
  },
] as const;

/** P-001's explicitly model-free learning operations. */
const DETERMINISTIC_MODEL_FREE_EDGES = [
  ['calibration', 'packages/operator-core/lib/blueprint-steps/ops/calibration-resolve.ts'],
  ['change-ledger', 'packages/operator-core/lib/blueprint-steps/ops/change-ledger-scan.ts'],
  ['deferral-interest', 'packages/operator-core/lib/blueprint-steps/ops/deferral-interest-refit.ts'],
  ['fleet-ekg', 'packages/operator-core/lib/blueprint-steps/ops/fleet-ekg-scan.ts'],
  ['graduation', 'packages/operator-core/lib/blueprint-steps/ops/graduation-scan.ts'],
  ['memory-precision', 'packages/operator-core/lib/blueprint-steps/ops/memory-precision-bench.ts'],
  ['memory-recall-canary', 'packages/operator-core/lib/blueprint-steps/ops/memory-live-recall-canary.ts'],
  ['negative-space', 'packages/operator-core/lib/blueprint-steps/ops/negative-space-scan.ts'],
  ['neologism', 'packages/operator-core/lib/blueprint-steps/ops/neologism-mine.ts'],
  ['red-queen', 'packages/operator-core/lib/blueprint-steps/ops/red-queen-drill.ts'],
] as const;

const EXPECTED_POLICY_IMPORTERS = [
  'packages/operator-core/lib/ablation/replay-leg.ts',
  'packages/operator-core/lib/ablation/runner.ts',
  'packages/operator-core/lib/dream/dream-config.ts',
  'packages/operator-core/lib/gym/autoloop-cycle.ts',
  'packages/operator-core/lib/gym/boot-spec.ts',
  'packages/operator-core/lib/gym/judge-scoring.ts',
  'packages/operator-core/lib/harness/routines/improvement-actions.ts',
  'packages/operator-core/lib/harness/routines/resolver-whole-corpus-action.ts',
  'packages/operator-core/lib/harness/routines/work-item-admission-bulk-dedup-action.ts',
  'packages/operator-core/lib/harness/routines/work-item-admission-daily-digest-action.ts',
  'packages/operator-core/lib/harness/routines/work-item-admission-delta-sweep-action.ts',
  'packages/operator-core/lib/harness/routines/work-item-admission-promoter-action.ts',
  'packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts',
  'packages/operator-core/lib/replay/battery.ts',
  'packages/operator-core/lib/replay/regret/replay-adapter.ts',
  'packages/operator-core/lib/resolver/whole-corpus-pass.ts',
  'packages/operator-core/lib/scout/models.ts',
  'packages/operator-core/lib/scout/register-scout-action.ts',
  'packages/operator-core/lib/transfer/live-deps.ts',
  'packages/operator-core/lib/work-items-admission-bulk-dedup.ts',
  'packages/operator-core/lib/work-items-admission-daily-digest.ts',
  'packages/operator-core/lib/work-items-admission-delta-sweep.ts',
  'packages/operator-core/lib/work-items-admission-promoter.ts',
] as const;

/**
 * The scope the noncanonical-provider-literal test POLICES. This one stays
 * curated on purpose: it is a whitelist of code that may not name a provider
 * model directly, and 70 files elsewhere in the package legitimately do.
 *
 * `harness/routines` earns its place because the scheduled admission actions
 * live there and drive real model calls; it carries zero provider-model
 * literals today (measured 2026-08-27..30), so it costs nothing to police. Its
 * addition also absorbs the one-file `improvement-actions.ts` special case that
 * used to be bolted onto the walk beside this list.
 */
const SCOPED_SOURCE_DIRS = [
  'packages/operator-core/lib/learning',
  'packages/operator-core/lib/scout',
  'packages/operator-core/lib/gym',
  'packages/operator-core/lib/iq-battery',
  'packages/operator-core/lib/transfer',
  'packages/operator-core/lib/replay',
  'packages/operator-core/lib/ablation',
  'packages/operator-core/lib/harness/routines',
] as const;

/**
 * The scope the IMPORTER INVENTORY scans — deliberately NOT curated.
 *
 * A hand-curated directory list is the defect this guard exists to catch, and
 * it caught nothing for exactly that reason: the three scheduled admission
 * actions imported the policy for weeks from `harness/routines`, outside every
 * SCOPED_SOURCE_DIRS entry, and one of them shipped with an inline
 * `LEARNING_MODEL_SPEC` at its llmCall and both ledger writes. Widening the
 * list one directory at a time only ever closes the instance you already found.
 *
 * `packages/operator-core/lib` is the COMPLETE population: no file under
 * `apps/`, `libs/`, `scripts/`, or any other package imports learning/model-policy
 * (measured 2026-08-30). Scanning all of it costs ~370ms.
 */
const POLICY_IMPORTER_SCAN_ROOT = 'packages/operator-core/lib';

const LEGACY_GYM_LAUNCHER_MODELS = new Map<string, ReadonlySet<string>>([
  ['packages/operator-core/lib/gym/ab-run.ts', new Set(['claude-sonnet-4-6'])],
  ['packages/operator-core/lib/gym/autoloop-cycle.ts', new Set(['claude-sonnet-4-6'])],
  ['packages/operator-core/lib/gym/blueprint-cycle.ts', new Set(['claude-sonnet-4-6'])],
  ['packages/operator-core/lib/gym/wake-mode.ts', new Set(['claude-haiku-4-5-20251001'])],
]);

function sourceAt(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function productionTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function scopedProductionSources(): string[] {
  return [...new Set(SCOPED_SOURCE_DIRS.flatMap((path) => productionTypeScriptFiles(resolve(ROOT, path))))].sort();
}

function policyImporterScanFiles(): string[] {
  return productionTypeScriptFiles(resolve(ROOT, POLICY_IMPORTER_SCAN_ROOT)).sort();
}

const POLICY_IMPORT = /from ['"][^'"]*learning\/model-policy['"]/;

/**
 * Extracted so non-vacuity is proven against synthetic file sets rather than by
 * mutating the shared tree — the same control shape the admission guards below
 * use. Returns violations in BOTH directions: an importer nobody declared, and
 * a declared path that no longer imports the policy (a stale inventory entry
 * silently widens the guard's blind spot just as an undeclared importer does).
 */
const importerInventoryViolations = (
  scannedRelativePaths: readonly string[],
  sourceOf: (relativePath: string) => string,
  expected: readonly string[],
): string[] => {
  const declared = new Set(expected);
  const found = new Set(scannedRelativePaths.filter((path) => POLICY_IMPORT.test(sourceOf(path))));
  return [
    ...[...found].filter((path) => !declared.has(path)).map((path) => `undeclared policy importer: ${path}`),
    ...[...declared].filter((path) => !found.has(path)).map((path) => `inventory names a non-importer: ${path}`),
  ].sort();
};

const PROVIDER_MODEL_ID = /\b(?:gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)*(?::[a-z]+)?|claude-(?:opus|sonnet|haiku)-[a-z0-9.-]+)\b/g;

function providerModelIdsInTypeScript(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      ids.push(...Array.from(node.text.matchAll(PROVIDER_MODEL_ID), (match) => match[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return ids;
}

describe('canonical learning model policy', () => {
  it('preserves the exact Sol xhigh owner directive without a family alias', () => {
    // Owner-directed [owner 2026-08-27]: Codex limits reset, so learning moved
    // back to the exact Sol xhigh spec after the temporary Opus 5 switch.
    // Owner-directed [owner 2026-09-30, directive #1111]: moved to GPT-6.1 Sol xhigh.
    expect(LEARNING_MODEL_ID).toBe('gpt-6.1-sol');
    expect(LEARNING_MODEL_EFFORT).toBe('xhigh');
    expect(LEARNING_MODEL_SPEC).toBe('gpt-6.1-sol:xhigh');
    expect(isCanonicalLearningModel(LEARNING_MODEL_SPEC)).toBe(true);
    // A near-miss family alias and a wrong effort must BOTH still be rejected —
    // that is what "without a family alias" buys, and it has to keep holding
    // across the provider change.
    expect(isCanonicalLearningModel('gpt-6.1:xhigh')).toBe(false);
    expect(isCanonicalLearningModel('gpt-6.1-sol:high')).toBe(false);
    // The superseded generation must not still read as canonical.
    expect(isCanonicalLearningModel('gpt-5.6-sol:xhigh')).toBe(false);
    // The temporary fallback must not still read as canonical.
    expect(isCanonicalLearningModel('claude-opus-5:xhigh')).toBe(false);
  });

  it('keeps every audited model-bearing edge on its canonical policy seam', () => {
    const violations: string[] = [];
    for (const edge of MODEL_BEARING_EDGES) {
      const source = sourceAt(edge.path);
      for (const marker of edge.markers) {
        if (!source.includes(marker)) violations.push(`${edge.id} (${edge.classification}) missing ${marker} in ${edge.path}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forces every new direct policy importer into the audited inventory', () => {
    const scanned = policyImporterScanFiles().map((absolute) => relative(ROOT, absolute));
    const violations = importerInventoryViolations(
      scanned,
      (path) => readFileSync(resolve(ROOT, path), 'utf8'),
      EXPECTED_POLICY_IMPORTERS,
    );
    expect(violations).toEqual([]);
  });

  it('control: the inventory guard CATCHES an importer hiding outside every curated directory', () => {
    // Non-vacuity, run against a synthetic file set so nothing in the shared
    // tree is mutated. The synthetic importer sits at a path under NO
    // SCOPED_SOURCE_DIRS entry — the exact shape that survived undetected.
    const hidden = 'packages/operator-core/lib/some-new-scheduled-runner.ts';
    expect(SCOPED_SOURCE_DIRS.some((dir) => hidden.startsWith(`${dir}/`))).toBe(false);

    const sources = new Map([
      ['packages/operator-core/lib/scout/models.ts', "import { LEARNING_MODEL_SPEC } from '../learning/model-policy';"],
      [hidden, "import { LEARNING_MODEL_SPEC } from './learning/model-policy';"],
      ['packages/operator-core/lib/unrelated.ts', "import { x } from './x';"],
    ]);
    const scanned = [...sources.keys()];
    const sourceOf = (path: string): string => sources.get(path) ?? '';

    expect(importerInventoryViolations(scanned, sourceOf, ['packages/operator-core/lib/scout/models.ts'])).toEqual([
      `undeclared policy importer: ${hidden}`,
    ]);
    // …declared, it passes — so the guard is not simply always-red.
    expect(
      importerInventoryViolations(scanned, sourceOf, ['packages/operator-core/lib/scout/models.ts', hidden]),
    ).toEqual([]);
    // …and a stale inventory entry is caught in the other direction.
    expect(
      importerInventoryViolations(scanned, sourceOf, [
        'packages/operator-core/lib/scout/models.ts',
        hidden,
        'packages/operator-core/lib/unrelated.ts',
      ]),
    ).toEqual(['inventory names a non-importer: packages/operator-core/lib/unrelated.ts']);
  });

  it('control: the importer scan reaches files no curated directory scope covers', () => {
    // The calibration the synthetic control above cannot give: that the REAL
    // scan root is genuinely wider than SCOPED_SOURCE_DIRS. The four admission
    // runners sit at the package root, under no curated entry; if a future edit
    // narrows the scan back to a curated list they drop out and this fails.
    const outsideCuratedScope = [
      'packages/operator-core/lib/work-items-admission-bulk-dedup.ts',
      'packages/operator-core/lib/work-items-admission-daily-digest.ts',
      'packages/operator-core/lib/work-items-admission-delta-sweep.ts',
      'packages/operator-core/lib/work-items-admission-promoter.ts',
    ];
    expect(outsideCuratedScope.filter((path) => SCOPED_SOURCE_DIRS.some((dir) => path.startsWith(`${dir}/`)))).toEqual(
      [],
    );
    const scanned = new Set(policyImporterScanFiles().map((absolute) => relative(ROOT, absolute)));
    expect(outsideCuratedScope.filter((path) => !scanned.has(path))).toEqual([]);
  });

  it('keeps explicitly deterministic learning operations model-free', () => {
    const modelBearingToken = /\b(?:LEARNING_MODEL_SPEC|llmCall|callLlm|spawnAgentInHarness|spawnInvokeOnce)\b/;
    const violations = DETERMINISTIC_MODEL_FREE_EDGES.flatMap(([id, path]) => {
      const match = sourceAt(path).match(modelBearingToken);
      return match ? [`${id} unexpectedly contains model-bearing token ${match[0]} in ${path}`] : [];
    });
    expect(violations).toEqual([]);
  });

  it('rejects noncanonical provider-model literals from scoped production learning code', () => {
    // The four Gym entrypoints retain a Claude-shaped AGENT_CMD only as the
    // compatibility launcher command; boot-spec's exhaustive AGENT_MODELS map
    // backend-swaps every real spawned role to the canonical learning policy.
    const violations: string[] = [];
    for (const absolute of scopedProductionSources()) {
      const path = relative(ROOT, absolute);
      for (const model of providerModelIdsInTypeScript(path, readFileSync(absolute, 'utf8'))) {
        if (model === LEARNING_MODEL_ID || model === LEARNING_MODEL_SPEC) continue;
        if (LEGACY_GYM_LAUNCHER_MODELS.get(path)?.has(model)) continue;
        violations.push(`${path}: ${model}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every built-in Gym rubric override canonical in source and sidecar projection', () => {
    // Neither root may make this guard's verdict depend on UNTRACKED local state, in
    // either direction — a crash on debris, or a silent empty walk.
    //
    // SOURCE is tracked, so it is mandatory: asserted present before the walk, because
    // "the directory vanished" must fail loudly rather than pass over zero blueprints.
    // SIDECAR is a generated projection — `apps/operator/dist-sidecar/` was gitignored
    // and untracked on 2026-09-02, so it is legitimately ABSENT from a clean checkout
    // (the gate's candidate checkout included) and is checked only when it is present.
    const SOURCE_ROOT = 'libs/papercusp/packages/harness/blueprints';
    const roots = [SOURCE_ROOT, 'apps/operator/dist-sidecar/blueprints'];
    expect(existsSync(resolve(ROOT, SOURCE_ROOT)), `${SOURCE_ROOT} is tracked and must exist`).toBe(true);
    const violations: string[] = [];
    let blueprintsChecked = 0;
    for (const root of roots) {
      const absoluteRoot = resolve(ROOT, root);
      if (!existsSync(absoluteRoot)) continue;
      for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(absoluteRoot, entry.name, 'blueprint.yaml');
        // A directory with no blueprint.yaml is not a blueprint. Git cannot track an
        // empty directory, so an abandoned local one (`worker/`, seen 2026-08-31) is
        // pure debris — reading it unconditionally turned that into an ENOENT crash
        // that reds this guard for a reason having nothing to do with model policy.
        if (!existsSync(path)) continue;
        blueprintsChecked += 1;
        const parsed = parseYaml(readFileSync(path, 'utf8')) as { gym?: { rubric?: { model?: unknown } } };
        const model = parsed.gym?.rubric?.model;
        if (model !== undefined && model !== LEARNING_MODEL_SPEC) {
          violations.push(`${relative(ROOT, path)}: gym.rubric.model=${String(model)}`);
        }
      }
    }
    // Non-vacuity: the two `continue`s above must never be able to walk nothing and
    // report compliance — that is the failure mode a skip-on-absence rule invites.
    expect(blueprintsChecked).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('has a non-vacuous provider-model literal detector', () => {
    expect(providerModelIdsInTypeScript('bad.ts', "const model = 'claude-opus-4-8';")).toEqual(['claude-opus-4-8']);
  });
});

describe('optionalModelSpec', () => {
  it('treats absent and blank overrides as "no override" so the caller falls back to policy', () => {
    // undefined/null are "the payload did not set it". A blank or whitespace
    // string is the admin-UI-cleared-the-field case and must NOT reach a
    // backend as an empty model id.
    expect(optionalModelSpec(undefined, 'promoter')).toBeUndefined();
    expect(optionalModelSpec(null, 'promoter')).toBeUndefined();
    expect(optionalModelSpec('', 'promoter')).toBeUndefined();
    expect(optionalModelSpec('   ', 'promoter')).toBeUndefined();
  });

  it('trims a real override and passes a NONCANONICAL spec through untouched', () => {
    expect(optionalModelSpec('  gpt-6.1-sol:xhigh  ', 'promoter')).toBe(LEARNING_MODEL_SPEC);
    // The whole point of a per-run override is escaping the canonical spec —
    // e.g. routing away from a model whose account is rate-limited or, as on
    // 2026-08-27, unsupported by the backing account. It must NOT be validated
    // against isCanonicalLearningModel.
    expect(optionalModelSpec('claude-opus-5:xhigh', 'promoter')).toBe('claude-opus-5:xhigh');
  });

  it('rejects a non-string payload and names the routine that received it', () => {
    for (const bad of [42, true, {}, []]) {
      expect(() => optionalModelSpec(bad, 'daily digest')).toThrow(/daily digest expected a model spec string/);
    }
  });
});

describe('scheduled admission paths resolve their model identically', () => {
  /**
   * D-035 regression guard. The plan gave bulk-dedup and daily-digest an
   * `opts.model` override and a resolve-once seam, but the promoter kept
   * `model: LEARNING_MODEL_SPEC` inline at its llmCall AND at both ledger
   * writes. Nothing failed: the promoter simply could not be steered off a
   * model whose account was rejecting it, and it is the SCHEDULED component
   * whose failures produce the queue's fail-open share.
   *
   * These files USED to sit outside every scanned scope, which is precisely why
   * the omission survived. That gap is closed: the importer inventory above now
   * scans POLICY_IMPORTER_SCAN_ROOT (the whole package) rather than a curated
   * directory list, and `harness/routines` was added to SCOPED_SOURCE_DIRS. The
   * widened scan immediately surfaced a FOURTH scheduled admission path,
   * delta-sweep, carrying the identical pre-fix shape — fixed here with the
   * others.
   */
  const ADMISSION_ACTIONS = [
    ['promoter', 'packages/operator-core/lib/harness/routines/work-item-admission-promoter-action.ts', 'admission promoter'],
    ['bulk-dedup', 'packages/operator-core/lib/harness/routines/work-item-admission-bulk-dedup-action.ts', 'bulk dedup'],
    ['daily-digest', 'packages/operator-core/lib/harness/routines/work-item-admission-daily-digest-action.ts', 'daily digest'],
    ['delta-sweep', 'packages/operator-core/lib/harness/routines/work-item-admission-delta-sweep-action.ts', 'delta sweep'],
  ] as const;

  it('routes every scheduled admission action payload through the shared helper', () => {
    const violations: string[] = [];
    for (const [id, path, label] of ADMISSION_ACTIONS) {
      const source = sourceAt(path);
      if (!/from ['"][^'"]*learning\/model-policy['"]/.test(source)) {
        violations.push(`${id} does not import the shared model policy (${path})`);
      }
      if (!source.includes(`optionalModelSpec(payload.model, '${label}')`)) {
        violations.push(`${id} does not pass payload.model through optionalModelSpec (${path})`);
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * The predicate, extracted so it can be run against synthetic sources. The
   * runner must resolve once into a local `model` and use THAT at the llmCall
   * and every ledger write, so admission_runs.model_id can never name a model
   * the run did not use.
   */
  const resolveOnceViolations = (label: string, source: string): string[] => {
    const violations: string[] = [];
    if (!/const model = opts\.model\?\.trim\(\) \|\| LEARNING_MODEL_SPEC;/.test(source)) {
      violations.push(`${label} lacks the resolve-once model seam`);
    }
    for (const seam of ['model: LEARNING_MODEL_SPEC', 'modelId: LEARNING_MODEL_SPEC']) {
      if (source.includes(seam)) violations.push(`${label} still binds the constant directly at "${seam}"`);
    }
    // A runner that writes its ledger row in raw SQL binds the constant in an
    // interpolation, not an object property — delta-sweep did exactly that
    // (`model_id = ${modelCalled ? LEARNING_MODEL_SPEC : null}`) and both
    // property-shaped checks above walked straight past it.
    if (/model_id\s*=\s*\$\{[^}]*LEARNING_MODEL_SPEC/.test(source)) {
      violations.push(`${label} still binds the constant directly at the SQL ledger write`);
    }
    return violations;
  };

  it('leaves no admission RUNNER binding the policy constant at a call or ledger seam', () => {
    const runners = [
      'packages/operator-core/lib/work-items-admission-promoter.ts',
      'packages/operator-core/lib/work-items-admission-bulk-dedup.ts',
      'packages/operator-core/lib/work-items-admission-daily-digest.ts',
      'packages/operator-core/lib/work-items-admission-delta-sweep.ts',
    ];
    expect(runners.flatMap((path) => resolveOnceViolations(path, sourceAt(path)))).toEqual([]);
  });

  it('control: the guard CATCHES the exact pre-fix promoter shape, and passes the fixed one', () => {
    // Non-vacuity, run against synthetic sources so nothing in the shared tree
    // is ever mutated to prove falsifiability. `preFix` is the body the
    // promoter actually had: inline at the llmCall and at both ledger writes.
    const preFix = [
      'const response = await opts.llmCall({',
      '  model: LEARNING_MODEL_SPEC,',
      '});',
      'await persistAdmissionPlan(sql, { modelId: LEARNING_MODEL_SPEC });',
    ].join('\n');
    const postFix = [
      'const model = opts.model?.trim() || LEARNING_MODEL_SPEC;',
      'const response = await opts.llmCall({',
      '  model,',
      '});',
      'await persistAdmissionPlan(sql, { modelId: model });',
    ].join('\n');

    const caught = resolveOnceViolations('synthetic', preFix);
    expect(caught).toContain('synthetic lacks the resolve-once model seam');
    expect(caught).toContain('synthetic still binds the constant directly at "model: LEARNING_MODEL_SPEC"');
    expect(caught).toContain('synthetic still binds the constant directly at "modelId: LEARNING_MODEL_SPEC"');
    // …and does not fire on the shape we actually shipped.
    expect(resolveOnceViolations('synthetic', postFix)).toEqual([]);
  });

  it('control: the guard CATCHES a raw-SQL ledger write bound to the constant', () => {
    // delta-sweep's real pre-fix shape. It passed BOTH property-shaped seam
    // checks while writing the constant into admission_runs.model_id, so this
    // control is what stops the SQL check from silently rotting away.
    const preFix = [
      'const response = await opts.llmCall({',
      '  model: LEARNING_MODEL_SPEC,',
      '});',
      'await sql`UPDATE harness_shared.admission_runs',
      '   SET model_id = ${modelCalled ? LEARNING_MODEL_SPEC : null}',
      ' WHERE id = ${runId}`;',
    ].join('\n');
    const postFix = [
      'const model = opts.model?.trim() || LEARNING_MODEL_SPEC;',
      'const response = await opts.llmCall({',
      '  model,',
      '});',
      'await sql`UPDATE harness_shared.admission_runs',
      '   SET model_id = ${modelCalled ? model : null}',
      ' WHERE id = ${runId}`;',
    ].join('\n');

    expect(resolveOnceViolations('synthetic', preFix)).toContain(
      'synthetic still binds the constant directly at the SQL ledger write',
    );
    expect(resolveOnceViolations('synthetic', postFix)).toEqual([]);
  });
});
