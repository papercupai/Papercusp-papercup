/**
 * Plan degradation-signals-on-condition-rail-2026-10-11, P-001 (BAR R-4): the measuring
 * inventory of failure/degradation signals that bypass the condition rail.
 *
 * Each of the five classes has a POSITIVE control (a site the scanner must report) and a
 * NEGATIVE control (the same shape on the rail, or only quoted in a comment/string, which it
 * must not report). The negative controls are what keep a positive control honest: a scanner
 * that reported every file would pass the positives alone.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSES,
  dispositionFor,
  dispositionProblem,
  inventory,
  isScannable,
  scanSites,
  scanSource,
} from '../../../../scripts/lib/condition-rail-inventory.mjs';

const classesOf = (src: string, file: string) => scanSource(src, file).map((r) => r.class);

describe('condition-rail inventory — class 1: owner-only alarms', () => {
  it('reports a notifyAttention / escalateAlarm call with no rail call beside it', () => {
    const src = `export async function check() {\n  await notifyAttention({ kind: 'x', title: 't', body: 'b' });\n}\n`;
    expect(classesOf(src, 'packages/x/lib/disk.ts')).toEqual(['owner-only-alarm']);
    const esc = `async function f() { await escalateAlarm({ title: 'a', body: 'b', cooldownMs: 1, source: 's' }); }\n`;
    expect(classesOf(esc, 'packages/x/lib/esc.ts')).toEqual(['owner-only-alarm']);
  });

  it('does not report a call that also raises a keyed condition, the declaration, or a quoted mention', () => {
    const onRail = `async function f() {\n  await notifyAttention({ kind: 'x', title: 't', body: 'b' });\n  broadcastSevereEvent({ conditionKey: 'degraded:x:y', title: 't' });\n}\n`;
    expect(classesOf(onRail, 'packages/x/lib/on-rail.ts')).toEqual([]);
    const decl = `export async function notifyAttention(input) { return input; }\n`;
    expect(classesOf(decl, 'packages/x/lib/attention-notify.ts')).toEqual([]);
    const quoted = `// call notifyAttention( here\nconst s = 'escalateAlarm(';\n`;
    expect(classesOf(quoted, 'packages/x/lib/quoted.ts')).toEqual([]);
  });

  it('requires the rail in call position, including for injected dependencies', () => {
    const injected = `async function guard(deps) {\n  const broadcast = deps.broadcast ?? broadcastSevereEvent;\n  await notifyAttention(input);\n  await broadcast(ev);\n}\n`;
    expect(classesOf(injected, 'packages/x/lib/injected.ts')).toEqual(['owner-only-alarm']);
    const called = `async function guard(deps) { await notifyAttention(input); await deps.broadcastSevereEvent(ev); }`;
    expect(classesOf(called, 'packages/x/lib/injected.ts')).toEqual([]);
    const commentOnly = `async function guard() {\n  // TODO: broadcastSevereEvent here\n  await notifyAttention(input);\n}\n`;
    expect(classesOf(commentOnly, 'packages/x/lib/comment-only.ts')).toEqual(['owner-only-alarm']);
  });
});

describe('condition-rail inventory — site identity and rail-call mutations (P-017)', () => {
  const file = 'packages/x/lib/system-health/check.ts';

  it.each([
    'broadcastSevereEvent({ conditionKey: "degraded:x:y" })',
    'broadcastSevereEventResolved("degraded:x:y")',
    'observeFallback("x", { eligible: 1, applied: 0, reason: "y" })',
    'deps.broadcastSevereEvent({ conditionKey: "degraded:x:y" })',
    'deps?.broadcastSevereEvent?.({ conditionKey: "degraded:x:y" })',
    'notifyAttention({ conditionKey: "degraded:x:y", title: "alarm" })',
    'notifyAttentionOnce({ conditionKey: "degraded:x:y", title: "alarm" })',
    'escalateAlarm({ conditionKey: "degraded:x:y", title: "alarm" })',
  ])('recognises %s as a call and catches its removal', (railCall) => {
    const source = `function check() { console.warn('falling back'); ${railCall}; }`;
    expect(scanSource(source, file).filter((r) => r.class === 'log-only-fallback')).toEqual([]);
    expect(scanSource(source.replace(railCall, 'void 0'), file).map((r) => r.class)).toEqual(['log-only-fallback']);
  });

  it('does not let a sibling function or variable named conditionKey hide a bypass', () => {
    const source = `
      function migrated() { notifyAttention(input); broadcastSevereEvent(event); }
      function untouched() { const conditionKey = 'degraded:x:y'; notifyAttention(input); }
    `;
    const sites = scanSites(source, file);
    expect(sites.map((r) => [r.enclosing, r.onRail])).toEqual([['migrated', true], ['untouched', false]]);
    expect(scanSource(source, file).map((r) => r.enclosing)).toEqual(['untouched']);
  });

  it('keeps health fields scoped to their own function', () => {
    const source = `
      function a() { broadcastSevereEvent(event); return { degraded: n > 5 }; }
      function b() { return { degraded: n > 5 }; }
    `;
    expect(scanSource(source, file).map((r) => [r.class, r.enclosing])).toEqual([['health-flag-no-condition', 'b']]);
  });

  it('does not use an outer function rail call to cover a nested callback', () => {
    const source = `function outer() { broadcastSevereEvent(event); run(() => { notifyAttention(input); }); }`;
    expect(scanSource(source, file).map((r) => [r.enclosing, r.onRail])).toEqual([['outer', false]]);
  });

  it('uses named declarations, arrows, properties and methods for stable identities', () => {
    const source = `
      function declared() { notifyAttention(input); }
      const arrow = () => { notifyAttention(input); };
      const obj = { property: function () { notifyAttention(input); }, method() { notifyAttention(input); } };
      class Alarm { check() { notifyAttention(input); } }
    `;
    expect(scanSites(source, file).map((r) => r.enclosing)).toEqual(['declared', 'arrow', 'property', 'method', 'check']);
  });

  it('counts on-rail siblings when assigning ordinals, so migration does not renumber rows', () => {
    const source = `function check() { notifyAttention(input); notifyAttention(input); }`;
    const before = scanSites(source, file);
    const after = scanSites(source.replace('notifyAttention(input)', 'notifyAttention({ conditionKey: key })'), file);
    expect(before.map((r) => r.id)).toEqual(after.map((r) => r.id));
    expect(before.map((r) => r.ordinal)).toEqual([1, 2]);
  });

  it('keeps a watchdog interval scoped to its function and waivers unconditionally off-rail', () => {
    const intervals = `function a() { broadcastSevereEvent(event); } function b() { managedSetInterval('x-watchdog', 10, () => work()); }`;
    expect(scanSource(intervals, 'packages/x/lib/boot.ts').map((r) => [r.class, r.enclosing])).toEqual([['bespoke-watchdog', 'b']]);
    const waiver = `broadcastSevereEvent(event); defineSignal({ id: 'x', waiver: { reason: 'accepted' } });`;
    expect(scanSource(waiver, file).map((r) => r.class)).toEqual(['signal-waiver']);
  });
});

describe('condition-rail inventory — class 2: log-only fallback decisions', () => {
  it('keeps a fallback site when its message moves into a local conditional constant', () => {
    const source = "function recordSidecarFallback(rejected) { const outcome = rejected ? 'rejected; local execution avoided' : 'fallback to local execution'; console.warn(`[sidecar] ${outcome}`); }";
    const rows = scanSource(source, 'packages/x/lib/sidecar.ts');
    expect(rows.map((row) => row.id)).toEqual([
      'log-only-fallback|packages/x/lib/sidecar.ts|recordSidecarFallback|1',
    ]);
    expect(scanSource(source.replace('console.warn', "observeFallback('sidecar', decision); console.warn"),
      'packages/x/lib/sidecar.ts')).toEqual([]);
  });

  it('follows constant aliases and concatenation while respecting lexical shadows', () => {
    expect(classesOf("const message = 'falling back'; function check() { const alias = message; logger.warn('gate: ' + alias); }",
      'packages/x/lib/gate.ts')).toEqual(['log-only-fallback']);
    for (const source of [
      "function other() { const message = 'falling back'; } function check() { console.warn(message); }",
      "const message = 'falling back'; function check(message) { console.warn(message); }",
      "const message = 'falling back'; function check() { const message = 'finished'; console.warn(message); }",
      "const message = 'falling back'; function check() { let message = unknown; console.warn(message); }",
    ]) expect(classesOf(source, 'packages/x/lib/gate.ts')).toEqual([]);
  });

  it('reads long arguments and ignores literal closing parentheses when locating the call end', () => {
    const long = `console.warn('${'x'.repeat(500)} falling back');`;
    const parens = `console.warn('connection (peer) closed: falling back');`;
    const nested = `console.warn(format('connection (peer)'), 'falling back');`;
    for (const source of [long, parens, nested]) {
      expect(classesOf(source, 'packages/x/lib/gate.ts')).toEqual(['log-only-fallback']);
      expect(classesOf(`function check() { ${source} observeFallback('gate', decision); }`, 'packages/x/lib/gate.ts')).toEqual([]);
    }
  });
  it('reports a log line that announces a fallback or fail-open with no rail call beside it', () => {
    const src = `try { go(); } catch (e) {\n  console.warn('[gate] proofs unavailable, falling back to full suite', e);\n}\n`;
    expect(classesOf(src, 'packages/x/lib/gate.ts')).toEqual(['log-only-fallback']);
    const failOpen = `if (!ok) { logger.warn(\`admission check failed open: \${why}\`); }\n`;
    expect(classesOf(failOpen, 'packages/x/lib/admit.ts')).toEqual(['log-only-fallback']);
  });

  it('does not report a fallback that is also observed, or a log line with other wording', () => {
    const observed = `catch (e) {\n  observeFallback({ mechanism: 'gate', eligible: 1, applied: 0, reason: 'x' });\n  console.warn('falling back to full suite');\n}\n`;
    expect(classesOf(observed, 'packages/x/lib/gate.ts')).toEqual([]);
    const other = `console.warn('[gate] run finished in 3s');\n`;
    expect(classesOf(other, 'packages/x/lib/gate.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — class 3: health fields with alarm flags but no condition', () => {
  it('reports an alarm-shaped field set to a value in a health file that never raises a condition', () => {
    const src = `export function sample(n: number) {\n  return { lagMs: n, degraded: n > 5000 };\n}\n`;
    expect(classesOf(src, 'packages/x/lib/system-health/ingest-health.ts')).toEqual(['health-flag-no-condition']);
  });

  it('does not report a type member, a field in a non-health file, or a health file on the rail', () => {
    const typeOnly = `export interface IngestHealth {\n  degraded: boolean;\n  alarm?: boolean;\n}\n`;
    expect(classesOf(typeOnly, 'packages/x/lib/system-health/ingest-health.ts')).toEqual([]);
    const nonHealth = `const r = { degraded: n > 5 };\n`;
    expect(classesOf(nonHealth, 'packages/x/lib/render.ts')).toEqual([]);
    const onRail = `const r = { degraded: n > 5 };\nif (r.degraded) broadcastSevereEvent({ conditionKey: 'degraded:ingest:lag' });\n`;
    expect(classesOf(onRail, 'packages/x/lib/system-health/ingest-health.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — class 4: bespoke rate watchdogs', () => {
  it('reports a watchdog module, or a named watchdog interval, that never raises a condition', () => {
    const mod = `export function sweep() { if (rate() < 0.1) console.error('low'); }\n`;
    expect(classesOf(mod, 'packages/x/lib/reuse-rate-watchdog.ts')).toEqual(['bespoke-watchdog']);
    const interval = `managedSetInterval('reuse-rate-watchdog', 60_000, () => check(), { category: 'watchdog' });\n`;
    expect(classesOf(interval, 'packages/x/lib/boot.ts')).toEqual(['bespoke-watchdog']);
  });

  it('does not report a watchdog that raises a keyed condition', () => {
    const onRail = `export function sweep() {\n  if (rate() < 0.1) broadcastSevereEvent({ conditionKey: 'degraded:reuse:rate' });\n}\n`;
    expect(classesOf(onRail, 'packages/x/lib/reuse-rate-watchdog.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — class 5: signal-actor-registry waivers', () => {
  it('reports each waiver on a defineSignal entry, naming the signal', () => {
    const src = `defineSignal({\n  id: 'reuse-collapse',\n  waiver: { reason: 'accepted', expiresAt: '2027-01-01' },\n});\n`;
    const rows = scanSource(src, 'packages/x/lib/signal-actor-registry.ts');
    expect(rows.map((r) => [r.class, r.symbol])).toEqual([['signal-waiver', 'reuse-collapse']]);
  });

  it('does not report an actor-backed entry or a waiver outside a signal registry', () => {
    const actor = `defineSignal({ id: 'reuse-collapse', actor: { kind: 'condition-bridge' } });\n`;
    expect(classesOf(actor, 'packages/x/lib/signal-actor-registry.ts')).toEqual([]);
    const elsewhere = `const policy = { waiver: { reason: 'x' } };\n`;
    expect(classesOf(elsewhere, 'packages/x/lib/policy.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — scope, dispositions and coverage', () => {
  it('scans source and skips tests, bundles, vendored assets and itself', () => {
    expect(isScannable('packages/operator-core/lib/alarm-attention.ts')).toBe(true);
    expect(isScannable('scripts/npm-install-safe.mjs')).toBe(true);
    for (const f of [
      'packages/operator-core/lib/alarm-attention.test.ts',
      'packages/operator-core/lib/__tests__/x.ts',
      'packages/operator-core/test/liveness-alarm-http-fixture.ts',
      'packages/operator-core/tests/helper.ts',
      'apps/operator/dist-host/hono-host.mjs',
      'apps/operator/public/docs/pagefind/pagefind.js',
      'libs/generic/papergrid/grid-core/storybook-static/sb-manager/runtime.js',
      'node_modules/x/index.js',
      'scripts/lib/condition-rail-inventory.mjs',
      'docs/readme.md',
    ]) {
      expect(isScannable(f), f).toBe(false);
    }
  });

  it('resolves the most specific disposition and flags malformed or missing ones', () => {
    const row = { id: 'owner-only-alarm|a.ts|check|1', class: 'owner-only-alarm', file: 'a.ts', line: 3, symbol: 'notifyAttention', key: 'owner-only-alarm|a.ts' };
    const cluster = { disposition: 'migrate', item: 'P-005' };
    const site = { disposition: 'not-applicable', reason: 'interactive CLI output read by the operator' };
    expect(dispositionFor(row, { 'owner-only-alarm|a.ts': cluster })).toBe(cluster);
    expect(dispositionFor(row, { 'owner-only-alarm|a.ts': cluster, 'owner-only-alarm|a.ts|notifyAttention': site })).toBe(site);
    expect(dispositionFor(row, { [row.id]: cluster, 'owner-only-alarm|a.ts|notifyAttention': site })).toBe(cluster);
    expect(dispositionProblem(null)).toBe('missing');
    expect(dispositionProblem({ disposition: 'migrate' })).toMatch(/P-NNN/);
    expect(dispositionProblem({ disposition: 'not-applicable', reason: 'short' })).toMatch(/reason/);
    expect(dispositionProblem(cluster)).toBeNull();
    expect(dispositionProblem(site)).toBeNull();
  });

  it('excludes one reviewed annotation without exempting a same-symbol runtime sibling', () => {
    const file = 'packages/x/lib/system-health/health.ts';
    const source = 'function check() { const alert: Alert | null = value; return { alert: value !== null }; }';
    const sites = scanSites(source, file);
    expect(sites.map((site) => [site.enclosing, site.ordinal, site.symbol])).toEqual([
      ['check', 1, 'alert'], ['check', 2, 'alert'],
    ]);
    const annotation = { disposition: 'not-applicable', reason: 'local type annotation does not write a health field' };
    const migration = { disposition: 'migrate', item: 'P-014' };
    const result = inventory({ root: '/nowhere', files: [file], readFile: () => source,
      dispositions: { [sites[0].key]: migration, [sites[0].id]: annotation } });
    expect(result.rows.map((row) => row.disposition)).toEqual([annotation, migration]);
    expect(result.staleDispositions).toEqual([]);
    // A symbol-wide exemption would silently waive the runtime field as well.
    expect(dispositionFor(sites[1], { [sites[0].id]: annotation })).toBeNull();
  });

  it('rejects stale exact row IDs even while the cluster and symbol remain live', () => {
    const file = 'packages/x/lib/system-health/health.ts';
    const source = 'function check() { return { alert: failed }; }';
    const [site] = scanSites(source, file);
    const staleId = `${site.key}|check|2`;
    const migration = { disposition: 'migrate', item: 'P-014' };
    const result = inventory({ root: '/nowhere', files: [file], readFile: () => source,
      dispositions: { [site.key]: migration, [staleId]: migration } });
    expect(result.staleDispositions).toEqual([staleId]);
    const migrated = inventory({ root: '/nowhere', files: [file],
      readFile: () => source.replace('return', 'broadcastSevereEvent(event); return'),
      dispositions: { [site.id]: migration } });
    expect(migrated.rows).toEqual([]);
    expect(migrated.staleDispositions).toEqual([site.id]);
  });

  it('inventories a file set into per-class counts, undispositioned sites and stale keys', () => {
    const files: Record<string, string> = {
      'packages/x/lib/disk.ts': `async function f() { await notifyAttention({ kind: 'x', title: 't', body: 'b' }); }\n`,
      'packages/x/lib/reuse-watchdog.ts': `export function sweep() {}\n`,
      'packages/x/lib/clean.ts': `export const x = 1;\n`,
    };
    const res = inventory({
      root: '/nowhere',
      files: Object.keys(files),
      dispositions: {
        'owner-only-alarm|packages/x/lib/disk.ts': { disposition: 'migrate', item: 'P-005' },
        'bespoke-watchdog|packages/x/lib/gone.ts': { disposition: 'migrate', item: 'P-005' },
      },
      readFile: (f: string) => files[f],
    });
    expect(res.scanned).toBe(3);
    expect(Object.keys(res.byClass)).toEqual([...CLASSES]);
    expect(res.byClass['owner-only-alarm']).toBe(1);
    expect(res.byClass['bespoke-watchdog']).toBe(1);
    expect(res.undispositioned).toBe(1);
    expect(res.staleDispositions).toEqual(['bespoke-watchdog|packages/x/lib/gone.ts']);
  });
});
