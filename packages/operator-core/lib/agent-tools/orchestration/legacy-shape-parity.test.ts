/**
 * WI-41006 — legacy input-shape parity census.
 *
 * The acceptance criterion `parity-kept-disable-earned` asserts that every
 * pre-existing `code:run` / `recipes:run` input shape is accounted for under the
 * unified orchestration door. That was originally graded DEGRADED for a specific
 * reason: the behavioural parity tests pass, but nobody had ENUMERATED the legacy
 * surface, so "the suite covers everything" was an unmeasured claim.
 *
 * This file closes that gap by DERIVING the legacy surface from the live tool
 * schemas instead of restating it in prose. Every legacy argument must appear in
 * LEGACY_FIELD_DISPOSITION below with an explicit disposition. Adding a new
 * argument to `code:run` or `recipes:run` fails this test until someone records
 * what happens to it under the unified door — which is the property the criterion
 * actually wanted, and the one a green behavioural suite cannot provide.
 *
 * NOTE ON SCOPE, established from the source rather than assumed: the legacy doors
 * are NOT removed by the unification. `public-contract.ts` refuses an unsupported
 * execution mode with "call a native compatibility door directly", and the parity
 * doc describes Codex `functions.exec` as "only a direct-call compatibility door".
 * So a legacy argument that the unified door does not front is only a REGRESSION if
 * the legacy door stopped accepting it. `fronted` vs `legacy-door-only` below encodes
 * exactly that distinction.
 */
import { describe, expect, it } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
import codeRunTool from '../code/run';
import recipesRunTool from '../recipes/run';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';
import { orchestrationSourceArgsSchema } from './public-contract';

/** Unwrap `.refine()` / `.strict()` wrappers to reach the underlying object shape. */
function objectShape(schema: unknown): Record<string, ZodTypeAny> {
  let cur = schema as {
    shape?: unknown;
    _def?: { schema?: unknown; innerType?: unknown; options?: unknown };
  };
  for (let hop = 0; hop < 10 && cur != null; hop += 1) {
    if (cur.shape && typeof cur.shape === 'object') return cur.shape as Record<string, ZodTypeAny>;
    const options = cur._def?.options;
    if (Array.isArray(options) && options.length > 0) {
      cur = options[0] as typeof cur;
      continue;
    }
    const next = cur._def?.schema ?? cur._def?.innerType;
    if (next == null) break;
    cur = next as typeof cur;
  }
  throw new Error('could not resolve a zod object shape');
}

type Disposition =
  | { kind: 'fronted'; unifiedPath: string }
  | { kind: 'legacy-door-only'; why: string };

/**
 * The census. Keys are legacy argument names; `code:run` and `recipes:run` share
 * several, so they are recorded per door.
 */
const LEGACY_FIELD_DISPOSITION: Record<string, Record<string, Disposition>> = {
  'code:run': {
    script: { kind: 'fronted', unifiedPath: 'script.source' },
    title: { kind: 'fronted', unifiedPath: 'script.title' },
    description: { kind: 'fronted', unifiedPath: 'script.description' },
    dryRun: { kind: 'fronted', unifiedPath: 'dryRun' },
    timeoutSec: { kind: 'fronted', unifiedPath: 'timeoutSec' },
    kernel: {
      kind: 'legacy-door-only',
      why:
        'Managed JavaScript kernel open/run/status/close operations are not part of the unified orchestration contract; callers use code:run directly for this process-local surface.',
    },
  },
  'recipes:run': {
    id: { kind: 'fronted', unifiedPath: 'recipe.id' },
    authority: { kind: 'fronted', unifiedPath: 'recipe.authority' },
    bindings: { kind: 'fronted', unifiedPath: 'bindings' },
    dryRun: { kind: 'fronted', unifiedPath: 'dryRun' },
    timeoutSec: { kind: 'fronted', unifiedPath: 'timeoutSec' },
    ids: {
      kind: 'legacy-door-only',
      why:
        'Batch replay (up to 50 recipe ids). The unified recipe selector is deliberately single-valued; ' +
        'batch remains reachable on recipes:run itself, so this is unfronted, not withdrawn.',
    },
    items: {
      kind: 'legacy-door-only',
      why:
        'Heterogeneous batch (per-item dryRun/timeoutSec/authority/bindings). Same disposition as `ids`: ' +
        'not fronted by the single-selector unified door, still accepted by recipes:run.',
    },
  },
};

/** Resolve a dotted path against the unified args schema. */
function unifiedPathExists(path: string): boolean {
  const segments = path.split('.');
  let shape: Record<string, ZodTypeAny>;
  try {
    shape = objectShape(orchestrationSourceArgsSchema);
  } catch {
    return false;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const field = shape[segments[i]!];
    if (field == null) return false;
    if (i === segments.length - 1) return true;
    try {
      shape = objectShape(field);
    } catch {
      return false;
    }
  }
  return false;
}

const DOORS: ReadonlyArray<readonly [string, unknown]> = [
  ['code:run', codeRunTool],
  ['recipes:run', recipesRunTool],
];

describe('WI-41006 — legacy orchestration input-shape parity census', () => {
  it.each(DOORS)('every %s argument has a recorded disposition', (doorName, tool) => {
    const shape = objectShape((tool as { args: unknown }).args);
    const declared = LEGACY_FIELD_DISPOSITION[doorName as string]!;

    // A NEW legacy argument lands here as an unmapped key and fails, which is the
    // whole point: the census cannot silently fall behind the schema it describes.
    expect(Object.keys(shape).sort()).toEqual(Object.keys(declared).sort());
  });

  it('every argument recorded as fronted resolves to a real field on the unified contract', () => {
    const unresolved: string[] = [];
    for (const [doorName, fields] of Object.entries(LEGACY_FIELD_DISPOSITION)) {
      for (const [fieldName, disposition] of Object.entries(fields)) {
        if (disposition.kind !== 'fronted') continue;
        if (!unifiedPathExists(disposition.unifiedPath)) {
          unresolved.push(`${doorName}.${fieldName} -> ${disposition.unifiedPath}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('every argument recorded as legacy-door-only is still accepted by its legacy door', () => {
    // Guards the one case that WOULD be a real regression: an unfronted argument
    // silently disappearing from the compatibility door that is supposed to keep it.
    const shape = objectShape((recipesRunTool as { args: unknown }).args);
    for (const [fieldName, disposition] of Object.entries(LEGACY_FIELD_DISPOSITION['recipes:run']!)) {
      if (disposition.kind !== 'legacy-door-only') continue;
      expect(shape[fieldName], `recipes:run lost ${fieldName}`).toBeDefined();
    }
  });

  // Falsifiability controls. A census that has never failed is a census nobody has
  // tested; these keep deliberately-wrong inputs in the file permanently rather than
  // mutating the shared tree to prove the detector works (see CLAUDE.md's mutation
  // -probe tiers — the module/logic subject keeps its control in-file).
  describe('controls — the census must actually be able to fail', () => {
    const control = z.object({ kept: z.string(), extra: z.number() });

    it('detects an argument present on the door but ABSENT from the census', () => {
      const shape = objectShape(control);
      const censusMissingOne = { kept: true };
      expect(Object.keys(shape).sort()).not.toEqual(Object.keys(censusMissingOne).sort());
    });

    it('detects a census entry that no longer exists on the door', () => {
      const shape = objectShape(control);
      const censusWithGhost = { kept: true, extra: true, removedLastYear: true };
      expect(Object.keys(shape).sort()).not.toEqual(Object.keys(censusWithGhost).sort());
    });

    it('unifiedPathExists returns false for a path the contract does not have', () => {
      // Calibration: the same helper must return TRUE for a path it does have, or
      // the negative result above would pass even with a broken resolver.
      expect(unifiedPathExists('script.source')).toBe(true);
      expect(unifiedPathExists('script.definitelyNotAField')).toBe(false);
      expect(unifiedPathExists('recipe.id')).toBe(true);
    });
  });

  it('fronted scalar bounds match between the legacy door and the unified contract', () => {
    // Round-tripping the same VALUE matters as much as the same field name: the
    // unified and legacy foreground doors must share the effective ceiling.
    const unified = orchestrationSourceArgsSchema;
    const scriptSource = 'x'.repeat(20_000);
    const maxTimeoutSec = FOREGROUND_TIMEOUT_CEILING_MS / 1000;

    expect(
      unified.safeParse({ script: { source: scriptSource }, timeoutSec: maxTimeoutSec }).success,
      'unified door must accept the foreground timeout ceiling and legacy maximum script length',
    ).toBe(true);

    expect(
      unified.safeParse({
        script: { source: 'ok', title: 'y'.repeat(120), description: 'z'.repeat(2_000) },
      }).success,
      'unified door must accept the legacy maximum title and description lengths',
    ).toBe(true);

    expect(
      unified.safeParse({ script: { source: 'ok' }, timeoutSec: maxTimeoutSec + 1 }).success,
      'unified door must reject beyond the foreground timeout ceiling, not silently widen it',
    ).toBe(false);
  });
});
