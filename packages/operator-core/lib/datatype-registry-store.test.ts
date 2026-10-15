/**
 * datatype-registry-store.test.ts — the PG-free, pure helpers of the datatype
 * registry store (P-013). The CRUD itself is integration-covered against PG; here
 * we pin the slug derivation + tier guard exhaustively (no PG / embedder), mirroring
 * the recipes-store test philosophy.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugifyDatatype,
  isDatatypeTier,
  DATATYPE_TIERS,
  DATATYPE_NATURES,
  BUILTIN_WORK_ITEM_KIND_NATURES,
  canonicalDatatypeKey,
  checkNatureSpec,
  isBuiltinWorkItemKind,
  legacyNatureForTier,
} from './datatype-registry-store';
import { WORK_ITEM_KINDS } from './work-items';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATION_1318 = join(REPO_ROOT, 'libs/papercusp/libs/db/sql/1318-datatype-nature.sql');

test('slugifyDatatype — lowercases, collapses non-alphanumerics to single dashes, trims', () => {
  assert.equal(slugifyDatatype('bet'), 'bet');
  assert.equal(slugifyDatatype('Bet Thesis'), 'bet-thesis');
  assert.equal(slugifyDatatype('  P&L  '), 'p-l');
  assert.equal(slugifyDatatype('calibration_record'), 'calibration-record');
  assert.equal(slugifyDatatype('Forecast (v2)'), 'forecast-v2');
  assert.equal(slugifyDatatype('---wager---'), 'wager');
  assert.equal(slugifyDatatype('Order #1 // fill'), 'order-1-fill');
});

test('isDatatypeTier — accepts the three tiers, rejects anything else', () => {
  assert.equal(isDatatypeTier('generic-kind'), true);
  assert.equal(isDatatypeTier('first-class'), true);
  assert.equal(isDatatypeTier('projection'), true);
  assert.equal(isDatatypeTier('bogus'), false);
  assert.equal(isDatatypeTier(''), false);
  assert.equal(isDatatypeTier('Generic-Kind'), false); // case-sensitive
});

test('DATATYPE_TIERS is the canonical three-tier set (D-002 + D-008 projection)', () => {
  assert.deepEqual([...DATATYPE_TIERS], ['generic-kind', 'first-class', 'projection']);
});

// ---------------------------------------------------------------------------
// EI-10562 — canonicalDatatypeKey is the THRESHOLD-FREE half of the dedup gate.
// The refusal path must be decidable with CERTAINTY, so it is an exact test on this
// key, never a similarity score. (The score it replaced refused 7 of 7 legitimate
// declarations at `>= 0.05` — cosine >= 0.083, the noise floor — and caught nothing.)
// ---------------------------------------------------------------------------

test('canonicalDatatypeKey — a word and its plural COLLIDE (the duplicate that actually happens)', () => {
  // The whole point: `orders` declared when `order` exists is an unmistakable duplicate.
  assert.equal(canonicalDatatypeKey('orders'), canonicalDatatypeKey('order'));
  assert.equal(canonicalDatatypeKey('fills'), canonicalDatatypeKey('fill'));
  assert.equal(canonicalDatatypeKey('Cash Balances'), canonicalDatatypeKey('cash-balance'));
  assert.equal(canonicalDatatypeKey('boxes'), canonicalDatatypeKey('box'));
  assert.equal(canonicalDatatypeKey('policies'), canonicalDatatypeKey('policy'));
  assert.equal(canonicalDatatypeKey('calibration_records'), canonicalDatatypeKey('Calibration Record'));
});

test('canonicalDatatypeKey — genuinely DISTINCT datatypes never collide, however similar they read', () => {
  // These are the live registry's real neighbours. `bet`/`wager` are near-synonyms that
  // score cosine 0.752 — the HIGHEST pair in the registry — and are nonetheless two
  // legitimately distinct registered kinds. No score can be trusted to tell them apart
  // from a true duplicate (bet/forecast, DISTINCT, scores 0.710). The key can.
  assert.notEqual(canonicalDatatypeKey('bet'), canonicalDatatypeKey('wager'));
  assert.notEqual(canonicalDatatypeKey('bet'), canonicalDatatypeKey('forecast'));
  assert.notEqual(canonicalDatatypeKey('fill'), canonicalDatatypeKey('order'));
  assert.notEqual(canonicalDatatypeKey('position'), canonicalDatatypeKey('cash-balance'));
  assert.notEqual(canonicalDatatypeKey('calibration-record'), canonicalDatatypeKey('forecast'));
});

test('canonicalDatatypeKey — the CONTRACT is collision, not spelling (assert the property, not the key)', () => {
  // The key is deliberately crude — 'status' → 'statu', 'bias' → 'bia'. That is fine and
  // is NOT what this guards: the only property the gate rests on is that a word and its
  // plural land on the SAME key. Pinning the key STRING would pin the implementation; the
  // contract is the collision. Being wrong about English is harmless if it is wrong
  // CONSISTENTLY on both sides.
  for (const [singular, plural] of [
    ['status', 'statuses'],
    ['bias', 'biases'],
    ['loss', 'losses'],
    ['match', 'matches'],
    ['entry', 'entries'],
  ] as const) {
    assert.equal(
      canonicalDatatypeKey(singular),
      canonicalDatatypeKey(plural),
      `${singular} / ${plural} must canonicalize together`,
    );
  }
  assert.equal(canonicalDatatypeKey('gas'), 'gas'); // len 3 → never stripped to nonsense
  assert.equal(canonicalDatatypeKey('loss'), 'loss'); // -ss → never eaten
});

test('canonicalDatatypeKey — KNOWN MISS, documented: irregular plurals do NOT collide, and that is the SAFE direction', () => {
  // 'thesis' → 'thesi' but 'theses' → 'thes'. A miss: the pair is a real plural and the
  // key does not catch it. Recorded deliberately rather than hidden, because the direction
  // matters — a miss ALLOWS the declaration (and the advisory `related[]` still surfaces the
  // neighbour). A refusal gate must fail toward allowing; the bug this replaces failed the
  // other way and refused everything. False negatives cost a nudge; false positives cost the
  // gate itself.
  assert.notEqual(canonicalDatatypeKey('bet-thesis'), canonicalDatatypeKey('bet-theses'));
});

test('canonicalDatatypeKey — IDEMPOTENT: canonical(canonical(x)) === canonical(x)', () => {
  // The invariant the gate rests on. Without it, a singular that merely ENDS in 's'
  // ('status') takes the bare-s rule while its plural takes the '-es' rule, they land on
  // different keys, and the duplicate walks through. Caught by the test above before it
  // shipped — which is the whole argument for writing the guard instead of the comment.
  for (const name of [
    'order', 'orders', 'status', 'statuses', 'bias', 'biases', 'loss', 'losses',
    'bet', 'wager', 'forecast', 'cash-balance', 'cash-balances', 'calibration-record',
    'gas', 'box', 'boxes', 'entry', 'entries', 'Bet Thesis', 'Order #1 // fill',
  ]) {
    const once = canonicalDatatypeKey(name);
    assert.equal(canonicalDatatypeKey(once), once, `not idempotent for "${name}"`);
  }
});

test('canonicalDatatypeKey — total: empty / punctuation-only / mixed input never throws', () => {
  assert.equal(canonicalDatatypeKey(''), '');
  assert.equal(canonicalDatatypeKey('---'), '');
  assert.equal(canonicalDatatypeKey('Order #1 // fill'), 'order-1-fill');
});

// ---------------------------------------------------------------------------
// enterprise-data-sources-2026-10-01 P-008 — every datatype states its NATURE (D-001), and
// work also states its AUDIENCE. checkNatureSpec mirrors the table CHECK in migration 1318:
// audience is set exactly when nature = work.
// ---------------------------------------------------------------------------

test('DATATYPE_NATURES is the D-001 four-nature set', () => {
  assert.deepEqual([...DATATYPE_NATURES], ['work', 'record', 'document', 'event']);
});

test('checkNatureSpec — work needs an audience; it is refused, never defaulted to agent', () => {
  assert.deepEqual(checkNatureSpec('work', 'agent'), { ok: true, value: { nature: 'work', audience: 'agent' } });
  assert.deepEqual(checkNatureSpec('work', 'human'), { ok: true, value: { nature: 'work', audience: 'human' } });
  for (const missing of [null, undefined, '', 'robot']) {
    const r = checkNatureSpec('work', missing);
    assert.equal(r.ok, false, `work with audience ${JSON.stringify(missing)} must be refused`);
    assert.equal(!r.ok && r.reason, 'audience_required');
  }
});

test('checkNatureSpec — data natures carry no audience', () => {
  for (const nature of ['record', 'document', 'event'] as const) {
    assert.deepEqual(checkNatureSpec(nature, null), { ok: true, value: { nature, audience: null } });
    assert.deepEqual(checkNatureSpec(nature, undefined), { ok: true, value: { nature, audience: null } });
    const r = checkNatureSpec(nature, 'agent');
    assert.equal(r.ok, false, `${nature} with an audience must be refused`);
    assert.equal(!r.ok && r.reason, 'audience_not_allowed');
  }
});

test('checkNatureSpec — an unknown nature is refused (case-sensitive, no coercion)', () => {
  for (const bad of ['Work', 'data', '', null, undefined, 3]) {
    const r = checkNatureSpec(bad, null);
    assert.equal(r.ok, false, `nature ${JSON.stringify(bad)} must be refused`);
    assert.equal(!r.ok && r.reason, 'invalid_nature');
  }
});

test('legacyNatureForTier — D-013 §5: generic-kind keeps today\'s claim behaviour, other tiers become records', () => {
  assert.deepEqual(legacyNatureForTier('generic-kind'), { nature: 'work', audience: 'agent' });
  assert.deepEqual(legacyNatureForTier('first-class'), { nature: 'record', audience: null });
  assert.deepEqual(legacyNatureForTier('projection'), { nature: 'record', audience: null });
});

test('BUILTIN_WORK_ITEM_KIND_NATURES covers exactly WORK_ITEM_KINDS, all agent work', () => {
  assert.deepEqual(Object.keys(BUILTIN_WORK_ITEM_KIND_NATURES).sort(), [...WORK_ITEM_KINDS].sort());
  for (const kind of WORK_ITEM_KINDS) {
    assert.equal(isBuiltinWorkItemKind(kind), true, kind);
    assert.deepEqual(BUILTIN_WORK_ITEM_KIND_NATURES[kind as keyof typeof BUILTIN_WORK_ITEM_KIND_NATURES], {
      nature: 'work',
      audience: 'agent',
    });
  }
  assert.equal(isBuiltinWorkItemKind('email-draft-proposal'), false);
  assert.equal(isBuiltinWorkItemKind('toString'), false); // own-property check, not the prototype
});

test('migration 1318 seeds the same built-in kinds as BUILTIN_WORK_ITEM_KIND_NATURES, and the same legacy rule', () => {
  const sql = readFileSync(MIGRATION_1318, 'utf8');
  const seed = new Map<string, { kind: string; nature: string; audience: string }>();
  const row = /\('([a-z-]+)', 'papercusp-workspace', NULL,[\s\S]*?'first-class', '([a-z-]+)',[\s\S]*?'(work|record|document|event)', '(agent|human)', now\(\)\)/g;
  for (const m of sql.matchAll(row)) seed.set(m[1], { kind: m[2], nature: m[3], audience: m[4] });
  assert.ok(seed.size > 0, 'parser matched no seed rows — the migration format changed, fix the test parser');
  assert.deepEqual([...seed.keys()].sort(), Object.keys(BUILTIN_WORK_ITEM_KIND_NATURES).sort());
  for (const [id, s] of seed) {
    const want = BUILTIN_WORK_ITEM_KIND_NATURES[id as keyof typeof BUILTIN_WORK_ITEM_KIND_NATURES];
    assert.equal(s.kind, id, `${id}: work_item_kind must equal the id`);
    assert.equal(s.nature, want.nature, `${id}: nature`);
    assert.equal(s.audience, want.audience, `${id}: audience`);
  }
  // The backfill and the expand-phase fill trigger both apply legacyNatureForTier's rule.
  const legacyRule = /CASE WHEN (?:NEW\.)?tier = 'generic-kind' THEN 'work' ELSE 'record' END/g;
  assert.equal([...sql.matchAll(legacyRule)].length, 2, 'backfill + fill trigger must both use the legacy rule');
});
