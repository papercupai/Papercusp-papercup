/**
 * no-hand-rolled-module-pin-guard.test.ts — the detection predicate behind
 * `scripts/check-no-hand-rolled-module-pin.mjs` (EI-19469900474673886).
 *
 * ## What the guard is for
 *
 * A module that pins its state with `globalThis[Symbol.for('...')]` is CORRECT —
 * two module records then share one object. It is also INVISIBLE:
 * `listModuleDuplications()` only knows about keys pinned through
 * `pinModuleState()`, so the realm-wide report answers a confident, clean `[]`
 * while that module is duplicated. That is the exact shape of the outage the
 * primitive exists to close (EI-19451658870832332): a surface reporting health
 * because its subject is invisible to it, not because the subject is healthy.
 *
 * ## Why the controls below are PERMANENT
 *
 * The whole-tree scan runs green today, which proves only the no-false-positive
 * direction. A guard that has only ever passed is a guard nobody has tested: if
 * the predicate silently stopped matching, the scan would keep printing ✔ and
 * the population would keep growing unseen — the same "detector cannot see its
 * subject" failure, one level up, in the thing built to prevent it.
 *
 * So the known-positive fixtures live here forever rather than being produced by
 * mutating a real file. That also sidesteps the repo's mutation hazards
 * entirely: no in-tree mutation means no git-sync sweep race and no restore
 * needed (see CLAUDE.md § "Proving a guard is falsifiable").
 *
 * ## Why this lives in apps/operator (@papercusp/web) and not operator-core
 *
 * The scan spans libs/ + packages/ + apps/, but `test:affected` selects suites
 * by WORKSPACE — so a whole-tree guard is only enforced for the workspaces that
 * select it (the guard-enforcement trap, WI-9434 / D-034). The enforcement point
 * was therefore chosen by MEASUREMENT, not by convention. Measured 2026-08-03,
 * for each area that actually holds a hand-rolled pin:
 *
 *   apps/operator/lib/chat-cards/ask-user-local.ts -> web                        ✓
 *   libs/generic/tooldef/src/state-channel.ts      -> tooldef, …, web            ✓
 *   libs/flags/src/server.ts                       -> flags, web, operator-core  ✓
 *   packages/operator-core/lib/agents-list.ts      -> operator-core, web, …      ✓
 *
 * @papercusp/web is selected by ALL FOUR; @papercusp/operator-core is selected
 * by only two of them (an apps/operator or tooldef pin would have escaped it
 * silently). This file started in operator-core for convention's sake and was
 * moved here once measured — the same mistake it guards against, since
 * "operator-core is where lint guards live" is a proxy for coverage, not
 * coverage.
 *
 * ⚠ Residual gap: @papercusp/operator-vite is its own island and selects
 * neither. Nothing there holds a pin today, and the whole-tree answer is always
 * one command away (`npm run lint:no-hand-rolled-module-pin`), but the complete
 * fix is a `lint:` gate leg, which runs regardless of workspace selection. That
 * was deliberately not added while `main` was frozen ~8h on an unrelated red
 * (WI-10510) with peers mid-incident in green-checkpoint.ts. Tracked on
 * EI-19479108855357092.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findPins, scanTree } from '../../../scripts/check-no-hand-rolled-module-pin.mjs';

/** The shape the guard exists to catch — a real pin, as written in this repo. */
const HAND_ROLLED_PIN = `
const REGISTRY_KEY = Symbol.for('@papercusp/thing:registry');
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: Map<string, string> };
function registry() {
  const g = globalThis as RegistryGlobal;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY];
}
`;

/** The sanctioned form — no Symbol.for, no globalThis, nothing to flag. */
const PINNED_THROUGH_PRIMITIVE = `
import { pinModuleState } from '@papercusp/module-singleton';
const state = pinModuleState('@papercusp/thing:registry', () => ({ registry: new Map() }));
`;

describe('no-hand-rolled-module-pin — predicate (known-positive controls)', () => {
  it('FLAGS a globalThis + Symbol.for pin', () => {
    const hits = findPins(HAND_ROLLED_PIN);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('@papercusp/thing:registry');
  });

  it('FLAGS the direct-index form too (no mapped-type cast)', () => {
    const src = `
      const SLOT = Symbol.for('papercusp.someCache');
      const cache = (globalThis as any)[SLOT] ?? ((globalThis as any)[SLOT] = new Map());
    `;
    expect(findPins(src)).toHaveLength(1);
  });

  it('FLAGS every distinct key in a file that pins more than one', () => {
    const src = `
      const A_KEY = Symbol.for('papercusp.a');
      const B_KEY = Symbol.for('papercusp.b');
      const g = globalThis as any;
      g[A_KEY] ??= new Map();
      g[B_KEY] ??= new Map();
    `;
    expect(findPins(src).map((h: { key: string }) => h.key).sort()).toEqual([
      'papercusp.a',
      'papercusp.b',
    ]);
  });
});

describe('no-hand-rolled-module-pin — predicate (known-negative controls)', () => {
  it('does NOT flag state pinned through the primitive', () => {
    expect(findPins(PINNED_THROUGH_PRIMITIVE)).toEqual([]);
  });

  it('does NOT flag reading a THIRD-PARTY well-known symbol (no globalThis)', () => {
    // packages/operator-core/lib/endpoint-route/routes/dev/table-schema.ts
    const src = `const ftName = ft[Symbol.for('drizzle:Name')];`;
    expect(findPins(src)).toEqual([]);
  });

  it('does NOT flag tagging a shared object that is not globalThis', () => {
    // packages/operator-core/lib/log-events.ts tags `console`, not the realm.
    const src = `
      const __installedFlag = Symbol.for('papercusp.console.intercepted');
      export function install(): void {
        const c = console as Console & { [k: symbol]: boolean };
        if (c[__installedFlag]) return;
        c[__installedFlag] = true;
      }
    `;
    expect(findPins(src)).toEqual([]);
  });

  it('does NOT flag a globalThis access that uses no key const at all', () => {
    // A plain property write, not a keyed pin. (Named for "no key const"
    // rather than "no Symbol.for": the predicate now accepts string keys too,
    // so the old wording described a rule that no longer exists.)
    const src = `const g = globalThis as Record<string, unknown>; g.someFlag = true;`;
    expect(findPins(src)).toEqual([]);
  });

  it('does NOT flag a string key indexed into something OTHER than globalThis', () => {
    // THE precision anchor for the string form. A string-keyed index is far too
    // common to match on shape — this is `process.env[K]` in
    // transport-adapters/configure.ts, which a globalThis-anchored rule must
    // leave alone. If this ever starts failing, the predicate has gone loose
    // and every env/localStorage read in the tree is about to be reported as a
    // realm pin.
    const src = `
      const FORCE_HTTP_ENV_NAME = 'PAPERCUSP_FORCE_HTTP_TRANSPORT';
      const g = globalThis as Record<string, unknown>;
      export function read(): string | undefined {
        return process.env[FORCE_HTTP_ENV_NAME];
      }
    `;
    expect(findPins(src)).toEqual([]);
  });
});

describe('no-hand-rolled-module-pin — the STRING-key form (the 2026-08-04 blind spot)', () => {
  // The predicate originally matched `Symbol.for(...)` ONLY, so it reported 14
  // remaining sites while 18 more files pinned with a plain string key and were
  // invisible to it — including three in harness-core.ts sitting beside a
  // fourth it did flag, and a fourth tooldef registry that a prior tranche
  // believed it had finished. These controls exist so the guard can never
  // silently narrow back to one spelling (EI-19479108855357092).

  it('FLAGS a plain-STRING key pinned through a globalThis alias', () => {
    const src = `
      const __pulseCacheKey = '__papercuspPulseCache';
      type PulseGlobals = { [__pulseCacheKey]?: Map<string, number> };
      const __pulseCache = (() => {
        const g = globalThis as PulseGlobals;
        if (!g[__pulseCacheKey]) g[__pulseCacheKey] = new Map();
        return g[__pulseCacheKey]!;
      })();
    `;
    const hits = findPins(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('__papercuspPulseCache');
    expect(hits[0].form).toBe('string');
  });

  it('FLAGS a string key indexed directly off a globalThis cast', () => {
    const src = `
      const ADV_INSIGHTS_CACHE_KEY = '__advInsightsCache';
      const cache =
        ((globalThis as Record<string, unknown>)[ADV_INSIGHTS_CACHE_KEY] as Map<string, number> | undefined) ??
        ((globalThis as Record<string, unknown>)[ADV_INSIGHTS_CACHE_KEY] = new Map());
    `;
    expect(findPins(src).map((h: { key: string }) => h.key)).toEqual(['__advInsightsCache']);
  });

  it('FLAGS a pin DECLARED only in a multi-line globalThis intersection type', () => {
    // scratch-gc.ts's shape: the indexing call site was deleted when DBOS took
    // over the schedule, leaving the pin type behind across two lines. A
    // line-local rule dropped it — i.e. widening the predicate silently LOST a
    // site it already had. Regression control for that specific mistake.
    const src = `
      const __SYM = Symbol.for('papercusp.scratchGcScheduler');
      type SchedulerGlobals = typeof globalThis & {
        [__SYM]?: { timer: ReturnType<typeof setInterval> | null };
      };
    `;
    expect(findPins(src).map((h: { key: string }) => h.key)).toEqual([
      'papercusp.scratchGcScheduler',
    ]);
  });

  it('reports BOTH key forms present in one file, each labelled by its form', () => {
    // harness-core.ts really is mixed: three string keys beside one symbol key.
    const src = `
      const __costCacheKey = '__papercuspCostCache';
      type CostGlobals = { [__costCacheKey]?: Map<string, number> };
      const __costCache = (() => {
        const g = globalThis as CostGlobals;
        if (!g[__costCacheKey]) g[__costCacheKey] = new Map();
        return g[__costCacheKey]!;
      })();
      const __aliveCacheKey = Symbol.for('papercusp.harnessAliveCache');
      type AliveGlobals = typeof globalThis & { [__aliveCacheKey]?: Map<string, boolean> };
      const __aliveCache = (() => {
        const g2 = globalThis as AliveGlobals;
        if (!g2[__aliveCacheKey]) g2[__aliveCacheKey] = new Map();
        return g2[__aliveCacheKey]!;
      })();
    `;
    const hits = findPins(src);
    expect(
      hits.map((h: { key: string; form: string }) => `${h.form}:${h.key}`).sort(),
    ).toEqual(['string:__papercuspCostCache', 'symbol:papercusp.harnessAliveCache']);
  });
});

describe('no-hand-rolled-module-pin — the tree', () => {
  it('has no UNALLOWLISTED hand-rolled pin', () => {
    const { violations } = scanTree();
    expect(
      violations.map((v: { rel: string; key: string }) => `${v.rel} (${v.key})`),
    ).toEqual([]);
  });

  it('the allowlist is not stale — every entry still holds a pin', () => {
    // A stale entry is not cosmetic: ALLOW is keyed by path, so an entry whose
    // file was migrated or moved silently re-permits a future pin at that path.
    const { stale } = scanTree();
    expect(stale).toEqual([]);
  });

  it('every migrated module is GONE from the population (the fix, asserted)', () => {
    // Asserted by PATH rather than by count: a count would drift every time a
    // peer migrates one more, and would pass for the wrong reason if a site
    // moved instead of being fixed.
    const { everyPin } = scanTree();
    const paths = new Set(everyPin.map((p: { rel: string }) => p.rel));
    for (const migrated of [
      // WI-10006112 — original config capture must report duplicated module records.
      'libs/test-config/src/executed-config-load-capture.ts',
      'libs/generic/eval-battery/src/source-identity.ts',
      // EI-19463700807328229 — the first subject
      'libs/generic/scheduled-registry/src/index.ts',
      // WI-307194 — a later sync bus-tap regression caught by the tree guard
      'libs/generic/sync/src/bus-tap.ts',
      // EI-19469900474673886 — the five @papercusp/* libs
      'libs/generic/lexicon/src/config.ts',
      'libs/generic/kokoro-tts/src/config.ts',
      'libs/generic/memory/src/config.ts',
      'libs/generic/memory/src/backend-registry.ts',
      'libs/generic/deployment-driver/src/registry.ts',
      // EI-19479108855357092 — the tooldef registries.
      // ⚠ NOT all of tooldef: `src/tool-projection.ts` pins a FOURTH registry
      // with a plain STRING key, so the detector could not see it while it
      // matched `Symbol.for` only, and this tranche read as "tooldef done"
      // when it was not. It is still in ALLOW.
      'libs/generic/tooldef/src/state-channel.ts',
      'libs/generic/tooldef/src/replay-buffer.ts',
      'libs/generic/tooldef/src/card-correlator.ts',
      // EI-19479108855357092 — flags + the operator-core caches
      'libs/flags/src/server.ts',
      'packages/operator-core/lib/spawnable-templates.ts',
      'packages/operator-core/lib/harness/projects-lite.ts',
      'packages/operator-core/lib/agents-list.ts',
      'packages/operator-core/lib/card-response-rate-limit.ts',
      'packages/operator-core/lib/harness-agent-runs.ts',
      // All FOUR of its pins (3 string keys + 1 Symbol.for) folded into ONE
      // pinModuleState call — the mixed-form file that proved the detector
      // had been form-blind. Its pre-migration shape survives as the two
      // predicate fixtures above; those are synthetic source strings, not
      // readers, so they stay unchanged on purpose.
      'packages/operator-core/lib/harness-core.ts',
      // The two coalescer singletons + the operator Cache. instance.ts also
      // folded in `cacheLayerOn`/`flagWiringInit`, which were module-local
      // while the Cache they govern was shared — a split wired one
      // onFlagChange subscription per record and left the kill-switch to
      // whichever record won the construction race (METHOD RULE 1).
      'packages/operator-core/lib/cache/instance.ts',
      'packages/operator-core/lib/cache/debounced-invalidate.ts',
      'packages/operator-core/lib/system-health/refresh-coalescer.ts',
      // Tranche 9 — all three verified free of external key readers by the
      // tree-wide map on the work item, so no reset seam was needed.
      'packages/operator-core/lib/events/registry.ts',
      'packages/operator-core/lib/rationale/service.ts',
      'packages/operator-core/lib/plugin-api-mount.ts',
      // Tranche 10. posthog-config pins ONLY its watcher state on purpose —
      // `cached`/`onConfigChange` stay per-record to feed the shared
      // invalidator list, so folding them in would be a behavior change, not
      // a completion of the migration. See the note in that file.
      'packages/operator-core/lib/operator-state-pg.ts',
      'packages/operator-core/lib/posthog-config.ts',
      // Tranche 11 — four sibling search sync-states, identical IIFE shape.
      // embed-backfill lagged the other three by one tranche: its test poked the
      // key directly in 4 places, so it needed BOTH a reset seam and a live READ
      // seam (__sweepStateForTest) before it could move. Its two in-place shape
      // upgrades (pre-WI-2905, pre-WI-7327) stayed OUTSIDE the pin factory —
      // the factory runs only on first create, so folding them in would have
      // silently stopped upgrading the stale shapes they exist for.
      'packages/operator-core/lib/search/doc-embed-sync.ts',
      'packages/operator-core/lib/search/session-ingest.ts',
      'packages/operator-core/lib/search/turn-chunk-sync.ts',
      'packages/operator-core/lib/search/embed-backfill.ts',
      // Tranche 12 — BOTH of its pins (the discovery cache and the dev
      // file-watcher handle ~1250 lines apart) folded into ONE, so a split
      // can't pin the cache while leaving a second fs.watch per record.
      'packages/operator-core/lib/plugin-host-runtime.ts',
    ]) {
      expect(paths.has(migrated)).toBe(false);
    }
  });

  it('labels every pin it finds in the tree with a known key form', () => {
    // The scanner's BOTH-FORM capability is proven by 'reports BOTH key forms
    // present in one file' above, against a synthetic fixture — and scanTree()
    // routes every file through that same findPins(), so that fixture covers
    // this property completely and cannot decay.
    //
    // This tree-level companion used to additionally require a `symbol`-form pin
    // to EXIST in the tree. That made it a guard which goes red on SUCCESS: the
    // moment the last hand-rolled Symbol.for site migrated (embed-backfill, the
    // only one left), it failed — demanding a hand-rolled pin exist forever to
    // satisfy the lint that exists to remove them. Proving detector capability
    // from live-tree contents inverts exactly when the migration completes.
    //
    // What the tree CAN attest without decaying: every hit it reports is labelled
    // with a real form, so a scanner that starts emitting unlabelled or
    // mystery-form hits is still caught — at any population size, including zero.
    const { everyPin } = scanTree();
    for (const pin of everyPin as { form: string }[]) {
      expect(['string', 'symbol']).toContain(pin.form);
    }
  });
});
