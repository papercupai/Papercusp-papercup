/**
 * Unit tests for the per-task-idempotent fleet-arm snapshot writer (benchmark-fairness-fix, Priority 2).
 *
 * The bug: an isolated `XBENCH_ONLY_IID` rerun (re-run EXACTLY one task) overwrote the whole `<arm>.json`
 * snapshot with just that one task, CLOBBERING every sibling's already-collected result. The fix
 * read-modify-writes by `instanceId` (mirroring run_minisweagent.py:update_preds + the PG
 * upsertBenchRunTask idempotency). Covers the pure merge + the on-disk read-modify-write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { priceFor } from '@papercusp/model-pricing';
import {
  assertArmModelPin,
  mergeArmSnapshot,
  readArmSnapshot,
  writeArmSnapshotMerged,
  type ArmSnapshot,
  type ArmSnapshotPerTask,
} from './arm-snapshot';
import {
  BENCH_DEFAULT_MODEL_ALIAS,
  assertModelInSnapshot,
  assertModelRegistrySnapshot,
  benchDefaultModelId,
  captureModelRegistrySnapshot,
  modelRegistrySnapshotId,
  pinEvaluatedModel,
  resolveEvaluatedModel,
  type ModelRegistrySnapshot,
} from './model-registry-snapshot';

const PIN = pinEvaluatedModel(BENCH_DEFAULT_MODEL_ALIAS, { now: new Date('2026-10-11T00:00:00Z') });

/** A registry snapshot whose content differs from the live one (so its id differs too). */
function otherRegistry(): ModelRegistrySnapshot {
  const entries = PIN.snapshot.entries.map((e) => (e.alias === 'luna' ? { ...e, priced: !e.priced } : e));
  return { ...PIN.snapshot, entries, snapshotId: modelRegistrySnapshotId({ ...PIN.snapshot, entries }) };
}

/**
 * A fixture registry snapshot that omits `modelId` entirely: no menu entry resolves to it and it is not in the
 * priced id list. Stands in for the registry having moved past a model that benchmark code once hard-coded.
 */
function registryWithout(modelId: string): ModelRegistrySnapshot {
  const entries = PIN.snapshot.entries.filter((e) => e.modelId !== modelId);
  const pricedModelIds = PIN.snapshot.pricedModelIds.filter((id) => id !== modelId);
  const content = { ...PIN.snapshot, entries, pricedModelIds };
  return { ...content, snapshotId: modelRegistrySnapshotId(content) };
}

function task(instanceId: string, over: Partial<ArmSnapshotPerTask> = {}): ArmSnapshotPerTask {
  return {
    instanceId,
    cupId: `bee-${instanceId}`,
    disposition: 'spawn',
    stopReason: 'done',
    generationError: null,
    tokensIn: 1000,
    tokensOut: 5000,
    costUsd: 4,
    turns: 3,
    wallClockMs: 60_000,
    diffBytes: 200,
    armMeta: null,
    ...over,
  };
}

function snapshot(arm: string, perTask: ArmSnapshotPerTask[], over: Partial<ArmSnapshot> = {}): ArmSnapshot {
  return {
    arm,
    runId: `run-${arm}`,
    runError: null,
    startedAt: '2026-06-16T00:00:00Z',
    wallMs: 1000,
    peakConcurrentBees: 2,
    taskCount: perTask.length,
    nonEmptyDiffs: perTask.filter((t) => (t.diffBytes ?? 0) > 0).length,
    totals: { costUsd: 0, tokensIn: 0, tokensOut: 0 },
    perTask,
    coordEvents: [],
    modelRegistry: PIN.snapshot,
    evaluatedModel: PIN.model,
    ...over,
  };
}

describe('mergeArmSnapshot — per-task idempotent merge', () => {
  it('a per-task RERUN merges into the existing snapshot — siblings are NOT clobbered', () => {
    // The original 3-task run.
    const existing = snapshot('su-independent', [task('iid-a'), task('iid-b'), task('iid-c')]);
    // A XBENCH_ONLY_IID rerun of ONLY iid-b, with a better result (was done, now still done w/ more cost).
    const rerun = snapshot('su-independent', [task('iid-b', { costUsd: 9, tokensIn: 2000, diffBytes: 999 })]);

    const merged = mergeArmSnapshot(existing, rerun);

    // All three tasks survive — the rerun did NOT drop iid-a / iid-c.
    expect(merged.perTask.map((t) => t.instanceId).sort()).toEqual(['iid-a', 'iid-b', 'iid-c']);
    // iid-b is the rerun's result (incoming wins for re-run instances).
    const b = merged.perTask.find((t) => t.instanceId === 'iid-b')!;
    expect(b.costUsd).toBe(9);
    expect(b.diffBytes).toBe(999);
    // iid-a / iid-c are preserved verbatim from the existing snapshot.
    expect(merged.perTask.find((t) => t.instanceId === 'iid-a')!.costUsd).toBe(4);
  });

  it('recomputes taskCount / totals / nonEmptyDiffs from the MERGED set (not the rerun-of-one)', () => {
    const existing = snapshot('su-independent', [
      task('iid-a', { costUsd: 4, tokensIn: 1000, tokensOut: 5000, diffBytes: 200 }),
      task('iid-b', { costUsd: 0, tokensIn: 0, tokensOut: 0, diffBytes: 0 }), // empty diff
    ]);
    const rerun = snapshot('su-independent', [task('iid-b', { costUsd: 6, tokensIn: 1000, tokensOut: 2000, diffBytes: 50 })]);

    const merged = mergeArmSnapshot(existing, rerun);
    expect(merged.taskCount).toBe(2); // both tasks, NOT 1 from the rerun
    expect(merged.totals).toEqual({ costUsd: 10, tokensIn: 2000, tokensOut: 7000 });
    expect(merged.nonEmptyDiffs).toBe(2); // iid-b now has a non-empty diff after the rerun
  });

  it('adds a NEW instance not present in the existing snapshot', () => {
    const existing = snapshot('su-independent', [task('iid-a')]);
    const incoming = snapshot('su-independent', [task('iid-z')]);
    const merged = mergeArmSnapshot(existing, incoming);
    expect(merged.perTask.map((t) => t.instanceId).sort()).toEqual(['iid-a', 'iid-z']);
  });

  it('with no existing snapshot, returns the incoming set as-is (recomputed totals)', () => {
    const incoming = snapshot('su-independent', [task('iid-a', { costUsd: 3 }), task('iid-b', { costUsd: 7 })]);
    const merged = mergeArmSnapshot(null, incoming);
    expect(merged.perTask).toHaveLength(2);
    expect(merged.totals!.costUsd).toBe(10);
  });

  it('takes run-level fields from incoming (latest run is authoritative for the window/trace)', () => {
    const existing = snapshot('hive-realqueen', [task('iid-a')], { runId: 'old', wallMs: 100, peakConcurrentBees: 1 });
    const incoming = snapshot('hive-realqueen', [task('iid-a')], { runId: 'new', wallMs: 999, peakConcurrentBees: 5 });
    const merged = mergeArmSnapshot(existing, incoming);
    expect(merged.runId).toBe('new');
    expect(merged.wallMs).toBe(999);
    expect(merged.peakConcurrentBees).toBe(5);
  });
});

describe('writeArmSnapshotMerged — on-disk read-modify-write', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a first write then a single-task rerun keeps every sibling on disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'arm-snap-'));
    const path = join(dir, 'su-independent.json');

    // First full run of 3 tasks.
    writeArmSnapshotMerged(path, snapshot('su-independent', [task('iid-a'), task('iid-b'), task('iid-c')]));
    let onDisk = JSON.parse(readFileSync(path, 'utf8')) as ArmSnapshot;
    expect(onDisk.perTask).toHaveLength(3);

    // XBENCH_ONLY_IID rerun of iid-b only (simulating the launcher re-running one instance).
    writeArmSnapshotMerged(path, snapshot('su-independent', [task('iid-b', { costUsd: 12 })]));
    onDisk = JSON.parse(readFileSync(path, 'utf8')) as ArmSnapshot;

    // The rerun did NOT clobber the file down to one task.
    expect(onDisk.perTask.map((t) => t.instanceId).sort()).toEqual(['iid-a', 'iid-b', 'iid-c']);
    expect(onDisk.perTask.find((t) => t.instanceId === 'iid-b')!.costUsd).toBe(12);
  });

  it('readArmSnapshot returns null for a missing or malformed file', () => {
    dir = mkdtempSync(join(tmpdir(), 'arm-snap-'));
    expect(readArmSnapshot(join(dir, 'nope.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json', 'utf8');
    expect(readArmSnapshot(bad)).toBeNull();
    const noPerTask = join(dir, 'nopertask.json');
    writeFileSync(noPerTask, JSON.stringify({ arm: 'x' }), 'utf8');
    expect(readArmSnapshot(noPerTask)).toBeNull();
  });
});

describe('arm model pin — every arm snapshot is pinned to a model-registry snapshot (R-9)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the written snapshot carries the registry snapshot and the model resolved from it', () => {
    dir = mkdtempSync(join(tmpdir(), 'arm-pin-'));
    const path = join(dir, 'su-independent.json');
    writeArmSnapshotMerged(path, snapshot('su-independent', [task('iid-a')]));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as ArmSnapshot;
    expect(onDisk.modelRegistry?.snapshotId).toBe(PIN.snapshot.snapshotId);
    expect(onDisk.evaluatedModel).toEqual(PIN.model);
    // The stored snapshot re-verifies against its own content.
    expect(() => assertArmModelPin(onDisk)).not.toThrow();
  });

  it('refuses to write an arm snapshot without a pin', () => {
    dir = mkdtempSync(join(tmpdir(), 'arm-pin-'));
    const path = join(dir, 'unpinned.json');
    const unpinned = snapshot('su-independent', [task('iid-a')], { modelRegistry: undefined, evaluatedModel: undefined });
    expect(() => writeArmSnapshotMerged(path, unpinned)).toThrow(/model-registry snapshot/);
    expect(readArmSnapshot(path)).toBeNull();
    const noModel = snapshot('su-independent', [task('iid-a')], { evaluatedModel: undefined });
    expect(() => writeArmSnapshotMerged(path, noModel)).toThrow(/no evaluatedModel/);
  });

  it('refuses a registry snapshot edited after capture, and a model resolved from another snapshot', () => {
    const tampered = { ...PIN.snapshot, entries: PIN.snapshot.entries.slice(1) };
    expect(() => assertArmModelPin(snapshot('a', [task('iid-a')], { modelRegistry: tampered }))).toThrow(/does not match its content/);
    const foreign = { ...PIN.model, snapshotId: otherRegistry().snapshotId };
    expect(() => assertArmModelPin(snapshot('a', [task('iid-a')], { evaluatedModel: foreign }))).toThrow(/resolved from registry snapshot/);
  });

  it('a rerun pinned to a different registry snapshot cannot merge into the arm', () => {
    const existing = snapshot('su-independent', [task('iid-a'), task('iid-b')]);
    const registry = otherRegistry();
    const rerun = snapshot('su-independent', [task('iid-b')], {
      modelRegistry: registry,
      evaluatedModel: resolveEvaluatedModel(BENCH_DEFAULT_MODEL_ALIAS, registry),
    });
    expect(() => mergeArmSnapshot(existing, rerun)).toThrow(/would mix two models/);
  });

  it('a rerun that omits the pin keeps the existing one', () => {
    const existing = snapshot('su-independent', [task('iid-a')]);
    const rerun = snapshot('su-independent', [task('iid-a')], { modelRegistry: undefined, evaluatedModel: undefined });
    const merged = mergeArmSnapshot(existing, rerun);
    expect(merged.modelRegistry?.snapshotId).toBe(PIN.snapshot.snapshotId);
    expect(merged.evaluatedModel).toEqual(PIN.model);
  });
});

describe('model-registry snapshot — evaluated models are derived, not hard-coded (R-9)', () => {
  it('the default alias resolves to a concrete, priced Claude id from the live registry', () => {
    const id = benchDefaultModelId();
    expect(id).toMatch(/^claude-opus-/);
    expect(priceFor(id)).not.toBeNull();
    expect(PIN.model).toMatchObject({ modelId: id, alias: BENCH_DEFAULT_MODEL_ALIAS, backend: 'claude', snapshotId: PIN.snapshot.snapshotId });
  });

  it('accepts alias forms with effort and window markers, Codex aliases, and priced concrete ids', () => {
    expect(resolveEvaluatedModel('opus[1m]:xhigh', PIN.snapshot).modelId).toBe(PIN.model.modelId);
    expect(resolveEvaluatedModel('sol', PIN.snapshot)).toMatchObject({ modelId: 'gpt-5.6-sol', backend: 'codex', alias: 'sol' });
    const concrete = resolveEvaluatedModel('anthropic/claude-haiku-4-5', PIN.snapshot);
    expect(concrete).toMatchObject({ modelId: 'claude-haiku-4-5', alias: null, backend: 'claude' });
  });

  it('refuses what it cannot pin or price instead of guessing', () => {
    // haiku is resolved by the Claude CLI itself, so there is no concrete id to pin.
    expect(() => resolveEvaluatedModel('haiku', PIN.snapshot)).toThrow(/only inside the Claude CLI/);
    expect(() => resolveEvaluatedModel('gemini-3.1-pro', PIN.snapshot)).toThrow(/neither a registry alias nor a priced model id/);
    expect(() => resolveEvaluatedModel('  ', PIN.snapshot)).toThrow(/empty model selector/);
  });

  it('the snapshot id is a content id: stable across captures, different when the registry changes', () => {
    const a = captureModelRegistrySnapshot({ now: new Date('2026-01-01T00:00:00Z') });
    const b = captureModelRegistrySnapshot({ now: new Date('2026-12-31T00:00:00Z') });
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.capturedAt).not.toBe(b.capturedAt);
    expect(otherRegistry().snapshotId).not.toBe(a.snapshotId);
    expect(assertModelRegistrySnapshot(a)).toBe(a);
    expect(a.entries.map((e) => e.alias)).toContain(BENCH_DEFAULT_MODEL_ALIAS);
  });
});

describe('a run record names only models its pinned snapshot resolves (FSWE-P010-REGISTRY falsifier)', () => {
  // The model the benchmark default resolves to today: the role a hard-coded pin used to play.
  const pinned = PIN.model.modelId;
  // A model June-era benchmark code hard-coded; still priced, so only the snapshot can refuse it.
  const formerPin = 'claude-opus-4-1';

  it('calibration: both models resolve against the live snapshot, and the fixture really omits them', () => {
    expect(resolveEvaluatedModel(formerPin, PIN.snapshot).modelId).toBe(formerPin);
    expect(PIN.snapshot.pricedModelIds).toContain(pinned);
    const fixture = registryWithout(formerPin);
    expect(fixture.pricedModelIds).not.toContain(formerPin);
    expect(fixture.snapshotId).not.toBe(PIN.snapshot.snapshotId);
    expect(assertModelRegistrySnapshot(fixture).snapshotId).toBe(fixture.snapshotId);
  });

  it('a dry run against a fixture snapshot that omits a formerly hard-coded model refuses it', () => {
    // Resolution reads the pinned list, not the live price table, which still prices formerPin.
    expect(priceFor(formerPin)).not.toBeNull();
    expect(() => pinEvaluatedModel(formerPin, { snapshot: registryWithout(formerPin) })).toThrow(/neither a registry alias nor a priced model id/);
    // Dated snapshot ids inherit only from a key the pinned list holds.
    expect(resolveEvaluatedModel(`${formerPin}-20250805`, PIN.snapshot).modelId).toBe(`${formerPin}-20250805`);
    expect(() => resolveEvaluatedModel(`${formerPin}-20250805`, registryWithout(formerPin))).toThrow(/neither a registry alias/);
    // The default alias cannot fall through to a model its snapshot no longer carries.
    expect(() => pinEvaluatedModel(BENCH_DEFAULT_MODEL_ALIAS, { snapshot: registryWithout(pinned) })).toThrow(/neither a registry alias/);
  });

  it('an arm record whose model id is absent from its own pinned snapshot is refused, even with a matching snapshot id', () => {
    dirForWrite = mkdtempSync(join(tmpdir(), 'arm-absent-'));
    const fixture = registryWithout(formerPin);
    const forged = { modelId: formerPin, alias: null, backend: 'claude' as const, snapshotId: fixture.snapshotId };
    const record = snapshot('su-independent', [task('iid-a')], { modelRegistry: fixture, evaluatedModel: forged });
    expect(() => assertArmModelPin(record)).toThrow(/is not in its pinned registry snapshot/);
    const path = join(dirForWrite, 'su-independent.json');
    expect(() => writeArmSnapshotMerged(path, record)).toThrow(/is not in its pinned registry snapshot/);
    expect(readArmSnapshot(path)).toBeNull();
  });

  it('an arm record whose alias resolves to a different id under its snapshot is refused', () => {
    const relabelled = { ...PIN.model, modelId: formerPin };
    expect(() => assertModelInSnapshot(relabelled, PIN.snapshot)).toThrow(/is not what its pinned registry snapshot/);
    expect(assertModelInSnapshot(PIN.model, PIN.snapshot)).toBe(PIN.model);
  });

  let dirForWrite: string | undefined;
  afterEach(() => {
    if (dirForWrite) rmSync(dirForWrite, { recursive: true, force: true });
    dirForWrite = undefined;
  });
});

describe('no hard-coded model ids in external-bench code or runbooks (R-9 falsifier)', () => {
  const ROOT = dirname(fileURLToPath(import.meta.url));
  /** Concrete model ids: Claude/GPT/Gemini/GLM families, with or without the vendor prefix. */
  const MODEL_ID_RE = /\b(?:claude-)?(?:opus|sonnet|haiku|fable)-\d+(?:[-.]\d+)*\b|\b(?:gpt|gemini|glm)-\d[\w.]*(?:-[a-z0-9.]+)*/gi;
  const SOURCE_RE = /\.(?:ts|mts|py|md|mdx)$/;

  // Cutoff facts describe exact vendor model identities; they do not choose the
  // evaluated model. Mask only their keyed literals, retaining every other pin
  // in this same file and every literal in other benchmark sources/runbooks.
  function selectionSource(file: string, source: string): string {
    if (file !== 'contamination.ts') return source;
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const spans: Array<{ start: number; end: number }> = [];
    const mask = (node: ts.Node) => spans.push({ start: node.getStart(parsed), end: node.end });
    for (const statement of parsed.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'MODEL_TRAINING_CUTOFFS') continue;
        const initializer = declaration.initializer;
        if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(parsed) !== 'Object.freeze') continue;
        const table = initializer.arguments[0];
        if (!table || !ts.isObjectLiteralExpression(table) || initializer.arguments.length !== 1) continue;
        for (const property of table.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isCallExpression(property.initializer)) continue;
          const value = property.initializer;
          if (!ts.isIdentifier(value.expression) || value.arguments.length !== 2) continue;
          if (value.expression.text === 'openai') {
            const id = value.arguments[0];
            if (!id || !ts.isStringLiteral(id) || id.text !== property.name.text) continue;
            mask(property.name);
            mask(id);
          } else if (value.expression.text === 'anthropic') {
            mask(property.name);
            const page = value.arguments[1];
            if (!page || !ts.isCallExpression(page) || !ts.isIdentifier(page.expression) || page.expression.text !== 'anthropicModelPage') continue;
            const slug = page.arguments[0];
            if (page.arguments.length === 1 && slug && ts.isStringLiteral(slug) && property.name.text === `claude-${slug.text}`) mask(slug);
          }
        }
      }
    }
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      source = source.slice(0, span.start) + source.slice(span.start, span.end).replace(/[^\n]/g, ' ') + source.slice(span.end);
    }
    return source;
  }

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__pycache__' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (SOURCE_RE.test(name) && !/\.test\.(?:ts|mts)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('calibration: the scan covers the tree and the pattern matches every family it must catch', () => {
    expect(sources(ROOT).length).toBeGreaterThan(50);
    const controls = ['claude-opus-4-8', 'opus-4-6', 'claude-sonnet-5', 'gpt-5.6-sol', 'gpt-5.4', 'gemini-3.1-pro', 'glm-5'];
    for (const c of controls) expect(`model ${c} here`.match(MODEL_ID_RE)).toEqual([c]);
    // Aliases and the registry's own vocabulary are not model ids.
    expect('opus sonnet[1m] sol luna'.match(MODEL_ID_RE)).toBeNull();
  });

  it('no non-test source names a concrete model id', () => {
    const hits: string[] = [];
    for (const file of sources(ROOT)) {
      const lines = selectionSource(relative(ROOT, file), readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        const m = line.match(MODEL_ID_RE);
        if (m) hits.push(`${relative(ROOT, file)}:${i + 1}: ${m.join(', ')}`);
      });
    }
    // Resolve the model from the registry (model-registry-snapshot.ts) instead of naming it.
    expect(hits).toEqual([]);
  });

  it('accepts sourced identity facts while detecting an evaluated pin in the same file', () => {
    const facts = `export const MODEL_TRAINING_CUTOFFS = Object.freeze({
      'gpt-5.4': openai('gpt-5.4', '2025-08-31'),
      'claude-opus-4-8': anthropic('2026-01', anthropicModelPage('opus-4-8')),
    });`;
    expect(selectionSource('contamination.ts', facts).match(MODEL_ID_RE)).toBeNull();
    expect(selectionSource('contamination.ts', `${facts}\nconst evaluatedModel = 'gpt-5.4';`).match(MODEL_ID_RE)).toEqual(['gpt-5.4']);
    expect(selectionSource('runner.ts', facts).match(MODEL_ID_RE)).not.toBeNull();
    expect(selectionSource('contamination.ts', `const OTHER_FACTS = {'gpt-5.4': '2025-08-31'};`).match(MODEL_ID_RE)).toEqual(['gpt-5.4']);
  });
});
