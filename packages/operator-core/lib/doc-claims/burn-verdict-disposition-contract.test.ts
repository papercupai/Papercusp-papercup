/**
 * The burn-verdict READER CONTRACT must stay true of the tree (P-005, plan
 * capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01). Sibling of
 * `same-listener-websocket-sites.test.ts` / `gate-candidate-ref.test.ts`, same family and same
 * discipline.
 *
 * THE FIXTURE CONTROLS ARE THE LOAD-BEARING PART. The moment the live assertion goes green it
 * stops being evidence that the detector works at all — and this detector guards an OMISSION, so
 * "found nothing" is exactly what a broken one produces. Each control reproduces a shape that MUST
 * be caught, or one that must NOT be, because a false positive here trains the next reader to
 * silence the guard rather than read it.
 *
 * The controls that matter most are the two the detector was actually WRONG about on first
 * writing, both found by running it against the live tree rather than against fixtures:
 *   - a bare `'shed'` union member is a VALUE, not a message (the guard flagged 6 type
 *     declarations before the prose rule);
 *   - an early-`return` branch's block does NOT contain the function's disposition logic, so a
 *     helper that stamps the disposition centrally still leaves each branch's reason string bare.
 * Both are pinned below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  carriesDisposition,
  enclosingBlock,
  findBurnCarrierTypes,
  findBurnVerdictStrings,
  isBurnDomainSource,
  judgeBurnDispositionContract,
  type AllowedBareVerdict,
} from './burn-verdict-disposition-contract';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * THE DECLARED SET. Strings that name a burn action but do NOT state a burn verdict. Adding an
 * entry is meant to be a deliberate, reviewable act — the same mechanism `judgeWsSites` uses, and
 * the reason a stale entry is itself reported as drift below.
 */
const ALLOWED_BARE_VERDICTS: readonly AllowedBareVerdict[] = [
  {
    file: 'packages/operator-core/lib/agent-tools/accounts/accounts.ts',
    match: 'per-IP Cloudflare edge throttle',
    reason:
      "The egress-IP-pool tool description, where 'throttle' names a CLOUDFLARE EDGE 429 on one " +
      'outbound IP — a different mechanism from the burn governor entirely, with no verdict, no ' +
      'action and no disposition to state. It is caught only because the word is shared.',
  },
  {
    file: 'packages/operator-core/lib/loop-pressure-governor.ts',
    match: 'event loop critically saturated',
    reason:
      'The PRESSURE lever, not the burn lever. This line sheds concurrency because the event loop ' +
      'is saturated — a measurement of THIS process, not a verdict about a provider account — so ' +
      'there is no burn disposition it could carry. The two levers share a module and the verb ' +
      '"shedding", which is the whole reason this needs saying rather than assuming.',
  },
  {
    file: 'packages/operator-core/lib/deployment/account-pool-store.ts',
    match: 'edge-throttled of',
    reason:
      'The edge-throttle tally is an egress-path measurement, not a burn-governor verdict. It ' +
      'counts accounts excluded by a live upstream edge throttle, while the burn disposition ' +
      'describes provider usage walls or local pacing policy; the two signals are intentionally ' +
      'reported together in this capacity summary.',
  },
  {
    file: 'packages/operator-core/lib/inference-gateway/burn-alert.ts',
    match: 'was DOWNGRADED from',
    reason:
      "The Codex PLAN-tier alarm (WI-6554700010029499). `${t.from}`/`${t.to}` interpolate a " +
      "subscription tier read from x-codex-plan-type ('pro', 'plus', 'free') — not a burn action — " +
      'so there is no burn verdict and no disposition to state. It is caught only because the ' +
      'PlanTransition shares the from/to field names with the burn transition in the same module.',
  },
  {
    file: 'packages/operator-core/lib/inference-gateway/burn-alert.ts',
    match: '(x-codex-plan-type) for account',
    reason:
      'The body of the same Codex PLAN-tier alarm: `${t.from}`/`${t.to}` are subscription tiers, ' +
      'not burn actions, so there is no burn disposition this string could carry.',
  },
  {
    file: 'packages/operator-core/lib/inference-gateway/burn-alert.ts',
    match: 'subscription for this account',
    reason:
      'The remedy line of the same Codex PLAN-tier alarm: `${t.from}` is the subscription tier to ' +
      'renew, not a burn action.',
  },
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-verify',
  'build',
  '.next',
  '.git',
  'coverage',
  '_retired',
  'e2e',
]);

function collectTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectTsFiles(full, out);
    else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The derived domain, computed once: every tree file that names the burn governor's vocabulary. */
function burnDomainFiles(): { rel: string; source: string }[] {
  const roots = ['apps/operator', 'packages', 'libs'].map((r) => join(ROOT, r));
  return roots
    .flatMap((r) => collectTsFiles(r))
    .map((file) => ({ rel: relative(ROOT, file), source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => isBurnDomainSource(source));
}

describe('burn-verdict disposition reader-contract (P-005)', () => {
  describe('domain derivation — a new emitter must enrol itself', () => {
    it('enrols a file that merely names the verdict vocabulary', () => {
      expect(isBurnDomainSource('const a: BurnAction = "shed";')).toBe(true);
      expect(isBurnDomainSource("import { evaluateBurn } from '../inference-gateway/burn-governor';")).toBe(
        true,
      );
    });

    it('does NOT enrol an unrelated file', () => {
      expect(isBurnDomainSource('export const total = 1; // nothing to do with accounts')).toBe(false);
    });

    it("does NOT enrol Scout's unrelated DedupBurnVerdict — a family-name collision", () => {
      // A guard that judged code it does not understand would report Scout's idea-dedup
      // verdicts as unstamped capacity verdicts, forever.
      expect(isBurnDomainSource('export interface DedupBurnVerdict { saturated: boolean }')).toBe(
        false,
      );
      expect(isBurnDomainSource('const v = await readDedupBurnVerdict(sql);')).toBe(false);
    });
  });

  describe('fixture controls — the detector must be able to FAIL', () => {
    it('catches a carrier type that declares an action with no disposition', () => {
      const carriers = findBurnCarrierTypes(
        'fixture.ts',
        'export interface PoolBurnRead {\n  action: BurnAction;\n  reason: string;\n}',
      );
      expect(carriers).toHaveLength(1);
      expect(carriers[0]!.carriesDisposition).toBe(false);
      expect(judgeBurnDispositionContract(carriers, [], []).ok).toBe(false);
    });

    it('accepts a carrier that declares the disposition beside the action', () => {
      const carriers = findBurnCarrierTypes(
        'fixture.ts',
        'export interface Ok {\n  action: BurnAction;\n  disposition: BurnDisposition;\n}',
      );
      expect(carriers[0]!.carriesDisposition).toBe(true);
    });

    it('catches a carrier declared as a type ALIAS — not just an interface', () => {
      // The same carrier wearing different syntax. A guard that only knew `interface` would hand
      // the next author a one-keyword way around it.
      const carriers = findBurnCarrierTypes(
        'fixture.ts',
        'export type PoolRead = {\n  action: BurnAction;\n  reason: string;\n};',
      );
      expect(carriers).toHaveLength(1);
      expect(carriers[0]!.name).toBe('PoolRead');
      expect(carriers[0]!.carriesDisposition).toBe(false);
    });

    it('accepts a persisted stamp whose field is NAMED for what it stamps', () => {
      // `lastBurnAction` / `lastBurnDisposition` — the contract is about the PAIR being present,
      // not about one blessed field name.
      const carriers = findBurnCarrierTypes(
        'fixture.ts',
        'export interface AccountRateState {\n  lastBurnAction?: BurnAction;\n  lastBurnDisposition?: BurnDisposition;\n}',
      );
      expect(carriers[0]!.carriesDisposition).toBe(true);
    });

    it('catches a hand-composed verdict string — the shape a renderer exists to prevent', () => {
      const found = findBurnVerdictStrings(
        'fixture.ts',
        'function tick() {\n  log(`pool burn \'${action}\' — cutting concurrency`);\n}',
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.via).toBe('interpolated-action');
      expect(found[0]!.carriesDisposition).toBe(false);
    });

    it('accepts the same line once it interpolates the rendered label', () => {
      const found = findBurnVerdictStrings(
        'fixture.ts',
        'function tick() {\n  log(`pool burn ${label} — shedding concurrency`);\n}',
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.carriesDisposition).toBe(true);
    });

    it('matches the allowlist against the FULL literal, not the display excerpt', () => {
      // Found the hard way: the excerpt is clipped at 120 chars, so an entry naming a phrase
      // late in a long tool description matched nothing — the entry then read as STALE while the
      // violation it covers stayed live. A guard failing in both directions at once, from one
      // field substitution that looked equivalent.
      const long = `'${'x'.repeat(200)} a per-IP Cloudflare edge throttle takes ONE IP out'`;
      const found = findBurnVerdictStrings('fixture.ts', `const d = ${long};`);
      expect(found).toHaveLength(1);
      expect(found[0]!.excerpt).not.toContain('Cloudflare');
      const verdict = judgeBurnDispositionContract(
        [],
        found,
        [{ file: 'fixture.ts', match: 'per-IP Cloudflare edge throttle', reason: 'control' }],
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('catches an early-RETURN branch whose reason string leaves the disposition behind', () => {
      // THE CONTROL FOR THE DETECTOR'S OWN NEAR-MISS. A helper that stamps the disposition
      // centrally reads as compliant, but each branch's own block is what the reader's string
      // was built in — and it holds nothing. Central stamping is precisely how the pool
      // aggregate lost the disposition in the first place.
      const found = findBurnVerdictStrings(
        'fixture.ts',
        [
          'function aggregate(rows) {',
          '  const disposition = strongest(rows);',
          '  if (counts.shed === total) {',
          '    return finish(`all ${total} account(s) shed — nowhere to route`);',
          '  }',
          '}',
        ].join('\n'),
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.carriesDisposition).toBe(false);
    });

    it('does NOT flag a bare action VALUE — a union member is not a message', () => {
      // Before the prose rule this flagged every `'none' | 'throttle' | 'shed'` in the domain.
      // A guard whose output is mostly noise is a guard nobody reads.
      expect(
        findBurnVerdictStrings('fixture.ts', "export type BurnAction = 'none' | 'throttle' | 'shed';"),
      ).toEqual([]);
      expect(findBurnVerdictStrings('fixture.ts', "if (action === 'shed') return;")).toEqual([]);
    });

    it('does NOT read a verdict string quoted inside a COMMENT as a real site', () => {
      // This file's own subject is prose ABOUT bare verdict strings; a comment-blind scanner
      // would report the paragraph documenting the defect as an instance of it.
      expect(
        findBurnVerdictStrings(
          'fixture.ts',
          [
            '/**',
            " * A log line reading `pool burn '${action}' — shedding concurrency` drops the basis.",
            ' */',
            "export const unrelated = 'code';",
            "// log(`pool burn '${action}' — shedding concurrency`)",
          ].join('\n'),
        ),
      ).toEqual([]);
    });

    it('survives template interpolation braces when finding the enclosing block', () => {
      // `${` opens a brace and its `}` closes it, so a template perturbs the depth count without
      // breaking it. Pinned rather than assumed: if this were wrong every windowed judgment in
      // the file would be silently computed against the wrong block.
      const source = 'function f() {\n  const d = disposition;\n  return `a ${x} b ${y} SHED here`;\n}';
      const block = enclosingBlock(source, source.indexOf('SHED here'));
      expect(block).toContain('const d = disposition');
      expect(block.startsWith('{')).toBe(true);
    });

    it('reads the disposition from an object literal, not merely from the file', () => {
      const stated = '{ action: \'shed\', disposition: \'measured-wall\', reason: `all shed` }';
      expect(carriesDisposition(stated)).toBe(true);
      expect(carriesDisposition("{ action: 'shed', reason: `all shed` }")).toBe(false);
    });

    it('accepts prose that spells the basis out instead of interpolating the field', () => {
      // burn-alert's severe-event body does exactly this, and forcing it to name the field
      // instead would make the reader-facing text worse to satisfy the guard.
      expect(carriesDisposition('PACING POLICY, NOT A MEASURED WALL. The governor projects...')).toBe(
        true,
      );
    });

    it('reports a STALE allowlist entry — drift in the other direction', () => {
      const verdict = judgeBurnDispositionContract([], [], ALLOWED_BARE_VERDICTS);
      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toHaveLength(ALLOWED_BARE_VERDICTS.length);
      expect(verdict.violations.join('\n')).toMatch(/stale allowlist hides the next real one/);
    });
  });

  describe('the live tree', () => {
    const domain = burnDomainFiles();

    it('derives a domain containing every known verdict producer', () => {
      const rels = domain.map((d) => d.rel);
      // A scanner that silently matched nothing would pass every assertion below vacuously —
      // the exact false-absence shape this whole file is about.
      for (const required of [
        'packages/operator-core/lib/inference-gateway/burn-governor.ts',
        'packages/operator-core/lib/inference-gateway/burn-alert.ts',
        'packages/operator-core/lib/deployment/account-pool.ts',
        'packages/operator-core/lib/loop-pressure-governor.ts',
      ]) {
        expect(rels, `derived burn domain is missing ${required}`).toContain(required);
      }
    });

    it('states the disposition on every verdict carrier and every verdict string', () => {
      const carriers = domain.flatMap((d) => findBurnCarrierTypes(d.rel, d.source));
      const strings = domain.flatMap((d) => findBurnVerdictStrings(d.rel, d.source));

      expect(carriers.length, 'scanned the domain and found no verdict carrier at all').toBeGreaterThan(3);
      expect(strings.length, 'scanned the domain and found no verdict string at all').toBeGreaterThan(8);

      const verdict = judgeBurnDispositionContract(carriers, strings, ALLOWED_BARE_VERDICTS);
      expect(verdict.violations.join('\n')).toBe('');
      expect(verdict.ok).toBe(true);
    });
  });
});
