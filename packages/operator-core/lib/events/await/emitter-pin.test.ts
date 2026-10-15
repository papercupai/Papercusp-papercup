/**
 * EI-21087476375596978 — EVENT_CATALOG's `emitter`/`exists` fields must stay true of
 * the code they describe.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the doc-claims siblings state:
 * once the live assertion goes green it stops being evidence that the detector works
 * at all. Every control below reproduces a shape that MUST be caught — including the
 * exact live drift this guard was written from (`escalation-resolved` naming two
 * files that CALL the emitter rather than the one that emits).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_CATALOG, type EventCatalogEntry } from './catalog';
import {
  DYNAMIC_KEY_FAMILIES,
  PATHLESS_EMITTER_FAMILIES,
  declaredEmitterPaths,
  emitterKeyHead,
  formatEmitterPinVerdict,
  judgeEmitterPins,
} from './emitter-pin';

// lib/events/await → lib/events → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** A minimal catalog entry; only the pinned fields vary per fixture. */
const entry = (over: Partial<EventCatalogEntry> & { family: string }): EventCatalogEntry => ({
  keyTemplate: `${over.family}:fired`,
  params: [],
  describe: 'fixture',
  emitter: 'fixture (packages/x/emit.ts)',
  exists: true,
  ...over,
});

/** Judge a fixture catalog against an in-memory file map. */
const judge = (
  catalog: readonly EventCatalogEntry[],
  files: Record<string, string>,
  over: { dynamic?: Record<string, string>; pathless?: Record<string, string> } = {},
) =>
  judgeEmitterPins({
    catalog,
    fileExists: (p) => files[p] !== undefined,
    readFile: (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
    dynamic: over.dynamic ?? {},
    pathless: over.pathless ?? {},
  });

describe('declaredEmitterPaths — the four ways a live emitter string writes a path', () => {
  it('reads the plain parenthesised form', () => {
    expect(declaredEmitterPaths('green-checkpoint (apps/operator/lib/release/green-checkpoint.ts)')).toEqual([
      'apps/operator/lib/release/green-checkpoint.ts',
    ]);
  });

  it('reads a path followed by a helper name inside the SAME parens', () => {
    expect(
      declaredEmitterPaths('goal-drain watchdog (packages/operator-core/lib/system-health/w.ts, defaultEmit)'),
    ).toEqual(['packages/operator-core/lib/system-health/w.ts']);
  });

  it('reads an UNPARENTHESISED path followed by prose — the form a parens-only reader sees as "no path"', () => {
    expect(declaredEmitterPaths('inbox-wake fan packages/operator-core/lib/x.ts — via coord:send')).toEqual([
      'packages/operator-core/lib/x.ts',
    ]);
  });

  it('reads every hop of a multi-file chain, deduped and in order', () => {
    expect(declaredEmitterPaths('a.mjs → apps/operator/scripts/e.ts → packages/operator-core/lib/f.ts')).toEqual([
      'apps/operator/scripts/e.ts',
      'packages/operator-core/lib/f.ts',
    ]);
  });

  it('finds no path in a bare subsystem label', () => {
    expect(declaredEmitterPaths('work-items-events')).toEqual([]);
  });
});

describe('fixture controls (the detector must be able to FAIL)', () => {
  it('catches an emitter path that does not exist — a moved or renamed file', () => {
    const v = judge([entry({ family: 'moved', emitter: 'x (packages/x/gone.ts)' })], {});
    expect(v.ok).toBe(false);
    expect(v.missingPaths).toHaveLength(1);
    expect(v.violations.join('\n')).toMatch(/does not exist/);
  });

  it('catches THE LIVE DRIFT: declared files that merely CALL the emitter', () => {
    // escalation-resolved named tools/resolve.ts + spawn/approve.ts. Both call
    // resolveEscalation(); neither contains the key. The emit is in escalations.ts.
    const v = judge(
      [
        entry({
          family: 'escalation-resolved',
          keyTemplate: 'escalation:resolved:<msgId>',
          params: [{ name: 'msgId', required: true, describe: 'msg id' }],
          emitter: 'coord:resolve (packages/x/resolve.ts) + spawn approve (packages/x/approve.ts)',
        }),
      ],
      {
        'packages/x/resolve.ts': 'const out = await resolveEscalation({ msg_id });',
        'packages/x/approve.ts': 'import { resolveEscalation } from "./escalations";',
      },
    );
    expect(v.ok).toBe(false);
    expect(v.unattributed).toHaveLength(1);
    expect(v.unattributed[0]!.head).toBe('escalation:resolved');
    expect(v.violations.join('\n')).toMatch(/appears NOWHERE/);
  });

  it('catches a NEW prose-only family that never declared itself dynamic', () => {
    const v = judge([entry({ family: 'p', keyTemplate: 'p:fired' })], {
      'packages/x/emit.ts': '// fires p:fired on every tick\nemit(buildIt());',
    });
    expect(v.ok).toBe(false);
    expect(v.undeclaredDynamic).toHaveLength(1);
    expect(v.violations.join('\n')).toMatch(/only in PROSE/);
  });

  it('a buildKey(family) emit is static code — the exemption doc\'s prescribed fix needs no exemption', () => {
    // The live drift (2026-10-13): pickup-sweep.ts built wake:not-picked-up via buildKey and
    // mentioned the head only in comments, so a head-only matcher read it as prose-only.
    const built = "// fires p:fired per tick\nemit({ key: buildKey('p', { id }) });";
    expect(judge([entry({ family: 'p', keyTemplate: 'p:fired' })], { 'packages/x/emit.ts': built }).ok).toBe(true);
    // Exact family match only: a buildKey for a prefix-sharing sibling does not attribute p.
    const sibling = "// fires p:fired per tick\nemit({ key: buildKey('p-other', { id }) });";
    const v = judge([entry({ family: 'p', keyTemplate: 'p:fired' })], { 'packages/x/emit.ts': sibling });
    expect(v.undeclaredDynamic).toHaveLength(1);
    // A buildKey call inside a comment is prose, not an emit.
    const commented = "// emit({ key: buildKey('p', { id }) }) fires p:fired\nemit(other());";
    expect(judge([entry({ family: 'p', keyTemplate: 'p:fired' })], { 'packages/x/emit.ts': commented }).undeclaredDynamic).toHaveLength(1);
    // And a buildKey emit spends a dynamic exemption exactly like a literal head does.
    const spent = judge([entry({ family: 'p', keyTemplate: 'p:fired' })], { 'packages/x/emit.ts': built }, { dynamic: { p: 'was built at runtime' } });
    expect(spent.staleDynamic).toHaveLength(1);
  });

  it('catches a SPENT dynamic exemption — the key became static code', () => {
    const v = judge(
      [entry({ family: 'p', keyTemplate: 'p:fired' })],
      { 'packages/x/emit.ts': "emit({ key: 'p:fired' });" },
      { dynamic: { p: 'was built at runtime' } },
    );
    expect(v.ok).toBe(false);
    expect(v.staleDynamic).toHaveLength(1);
    expect(v.violations.join('\n')).toMatch(/exemption is spent/);
  });

  it('catches a NEW emitter string that names no path at all', () => {
    const v = judge([entry({ family: 'p', emitter: 'some-subsystem' })], {});
    expect(v.ok).toBe(false);
    expect(v.undeclaredPathless).toHaveLength(1);
    expect(v.violations.join('\n')).toMatch(/names no source path/);
  });

  it('catches a SPENT pathless exemption — the emitter grew a path', () => {
    const v = judge(
      [entry({ family: 'p', keyTemplate: 'p:fired', emitter: 'sub (packages/x/emit.ts)' })],
      { 'packages/x/emit.ts': "emit({ key: 'p:fired' });" },
      { pathless: { p: 'no single file' } },
    );
    expect(v.ok).toBe(false);
    expect(v.stalePathless).toHaveLength(1);
    expect(v.violations.join('\n')).toMatch(/delete the entry/);
  });

  it('catches a STALE exists:false — the Phase-2 addition landed but nobody flipped it', () => {
    const v = judge([entry({ family: 'p', keyTemplate: 'p:fired', exists: false })], {
      'packages/x/emit.ts': "emit({ key: 'p:fired' });",
    });
    expect(v.ok).toBe(false);
    expect(v.staleExistsFalse).toHaveLength(1);
    expect(v.violations.join('\n')).toMatch(/flip exists to true/);
  });

  it('a genuinely correct entry passes — the controls above are not just "everything fails"', () => {
    const v = judge([entry({ family: 'p', keyTemplate: 'p:fired' })], {
      'packages/x/emit.ts': "await emitAwaitedEvent({ key: 'p:fired' });",
    });
    expect(formatEmitterPinVerdict(v)).toBe('');
    expect(v.ok).toBe(true);
  });
});

describe('the leniency tier 2 buys, and its stated bound', () => {
  it('registers repeated-recovery as the same dynamic fleet-transition key family', () => {
    expect(DYNAMIC_KEY_FAMILIES['fleet-repeated-recovery']).toContain('fleetTransitionKey');
  });

  it('registers member-left as the same dynamic fleet-transition key family', () => {
    expect(DYNAMIC_KEY_FAMILIES['fleet-member-left']).toContain('fleetTransitionKey');
  });

  it('does NOT fire on a key BUILDER that interpolates the family segment', () => {
    // `fleet:${kind}:${slug}` — "fleet:member-dead" is nowhere in the file, so only
    // the prose mention keeps this attributable at all. This is the case that would
    // fail 12 correct families if the guard demanded a static emit.
    const v = judge(
      [
        entry({
          family: 'fleet-member-dead',
          keyTemplate: 'fleet:member-dead:<slug>',
          params: [{ name: 'slug', required: true, describe: 'fleet' }],
          emitter: 'fleet transitions (packages/x/fleet.ts)',
        }),
      ],
      {
        'packages/x/fleet.ts':
          '/** fires fleet:member-dead:<slug> */\nexport const k = (s, kind) => `fleet:${kind}:${s}`;',
      },
      { dynamic: { 'fleet-member-dead': 'kind segment is interpolated' } },
    );
    expect(v.ok).toBe(true);
  });

  it('STATED BOUND: a key named only in a doc comment satisfies tier 2 — which is why tier 3 records it', () => {
    const v = judge(
      [entry({ family: 'p', keyTemplate: 'p:fired' })],
      { 'packages/x/emit.ts': '// p:fired is documented here but never emitted\n' },
      { dynamic: { p: 'documented-only in this fixture' } },
    );
    // Tier 2 passes on prose alone by design; the exemption is what makes it visible.
    expect(v.unattributed).toHaveLength(0);
    expect(v.ok).toBe(true);
  });

  it('one declared file emitting the key is enough when a sibling does not (any-of, not all-of)', () => {
    const v = judge(
      [entry({ family: 'p', keyTemplate: 'p:fired', emitter: 'a (packages/x/a.ts) + b (packages/x/b.ts)' })],
      { 'packages/x/a.ts': 'unrelated();', 'packages/x/b.ts': "emit({ key: 'p:fired' });" },
    );
    expect(v.ok).toBe(true);
  });
});

describe('THE GUARD — every EVENT_CATALOG emitter/exists claim matches the live tree', () => {
  const live = () =>
    judgeEmitterPins({
      catalog: EVENT_CATALOG,
      fileExists: (p) => existsSync(join(ROOT, p)),
      readFile: (p) => readFileSync(join(ROOT, p), 'utf8'),
    });

  it('resolves the repo root (a wrong root would pass everything vacuously)', () => {
    expect(existsSync(join(ROOT, 'packages/operator-core/lib/events/await/catalog.ts'))).toBe(true);
  });

  it('holds for the whole live catalog', () => {
    const verdict = live();
    expect(formatEmitterPinVerdict(verdict), formatEmitterPinVerdict(verdict)).toBe('');
    expect(verdict.ok).toBe(true);
  });

  it('actually examined the catalog — the live run is not silently empty', () => {
    expect(EVENT_CATALOG.length).toBeGreaterThan(40);
    const withPaths = EVENT_CATALOG.filter((e) => declaredEmitterPaths(e.emitter).length > 0);
    expect(withPaths.length).toBeGreaterThan(40);
  });

  it('every exemption is USED — a stale entry is a gap parked forever', () => {
    const families = new Set(EVENT_CATALOG.map((e) => e.family));
    for (const family of Object.keys(DYNAMIC_KEY_FAMILIES)) expect(families).toContain(family);
    for (const family of Object.keys(PATHLESS_EMITTER_FAMILIES)) expect(families).toContain(family);
  });

  it('every exemption carries a non-empty REASON', () => {
    for (const [family, reason] of Object.entries({ ...DYNAMIC_KEY_FAMILIES, ...PATHLESS_EMITTER_FAMILIES })) {
      expect(reason.length, `${family} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('HISTORICAL CONTROL: the pre-fix emitter string FAILS against the real tree', () => {
    // The measured drift (2026-08-31). Judging the REAL catalog and the REAL files
    // with only this one string reverted proves the live assertion above is load-
    // bearing rather than vacuously green — and does it against a COPY, so the
    // shared tree is never mutated to prove a guard falsifiable.
    const PRE_FIX =
      'coord:resolve (packages/operator-core/lib/agent-tools/coordination/tools/resolve.ts) + spawn approve (packages/operator-core/lib/agent-tools/spawn/approve.ts)';
    const reverted = EVENT_CATALOG.map((e) =>
      e.family === 'escalation-resolved' ? { ...e, emitter: PRE_FIX } : e,
    );
    // The revert must be real: both pre-fix paths still exist, so this is a genuine
    // attribution failure and not a tier-1 missing-file failure wearing its clothes.
    for (const path of declaredEmitterPaths(PRE_FIX)) {
      expect(existsSync(join(ROOT, path)), `${path} should still exist`).toBe(true);
    }

    const verdict = judgeEmitterPins({
      catalog: reverted,
      fileExists: (p) => existsSync(join(ROOT, p)),
      readFile: (p) => readFileSync(join(ROOT, p), 'utf8'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.missingPaths).toHaveLength(0);
    expect(verdict.unattributed.map((f) => f.family)).toEqual(['escalation-resolved']);
  });

  it('the key head searched for is the SAME string the live-awaiter join uses', () => {
    // Reusing familyKeyPrefix is what keeps this guard from becoming a second
    // derivation that can itself drift from the catalog.
    const escalation = EVENT_CATALOG.find((e) => e.family === 'escalation-resolved')!;
    expect(emitterKeyHead(escalation)).toBe('escalation:resolved');
  });
});
