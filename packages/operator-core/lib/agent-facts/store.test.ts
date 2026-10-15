/**
 * agent-facts store — unit tests for the pure parts (queen-memory-hybrid L1b):
 * scope validation per D-001 (harness/work_item optional; workspace ref-less)
 * and the deterministic fold rendering. SQL paths are exercised by the tools'
 * live-verify (the store is a thin tagged-template layer over one table).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { InvalidInputError } from '@papercusp/tooldef';
import {
  assertFact,
  excerptEvictedBody,
  FACT_EVICTION_EXCERPT_CHARS,
  parseFactSourceProvenance,
  parseFactMeasurement,
  FACT_VOLATILE_MAX_TTL_SEC,
  renderFactSrc,
  renderFactsFold,
  resolveFactScopeRef,
  resolveFederationWorkspace,
  retractFact,
  validateAudienceScope,
  validateFactScope,
  validateFactScopeRefShape,
  type AgentFact,
  type FactSourceProvenance,
} from './store';

describe('resolveFederationWorkspace (F1-4 / WI-1564)', () => {
  it('returns the workspace when it federates', () => {
    expect(resolveFederationWorkspace('papercusp-workspace')).toBe('papercusp-workspace');
    expect(resolveFederationWorkspace('  oddsmith-ws  ')).toBe('oddsmith-ws');
  });

  it('returns undefined for the non-federating coordination / wildcard / empty partitions', () => {
    expect(resolveFederationWorkspace('default')).toBeUndefined(); // DEFAULT_COORD_WORKSPACE
    expect(resolveFederationWorkspace('*')).toBeUndefined();
    expect(resolveFederationWorkspace('')).toBeUndefined();
    expect(resolveFederationWorkspace('   ')).toBeUndefined();
    expect(resolveFederationWorkspace(null)).toBeUndefined();
    expect(resolveFederationWorkspace(undefined)).toBeUndefined();
  });
});

describe('assertFact WI-1564 stranding guard (F1-4)', () => {
  // A stub that throws if the SQL layer is ever reached — proves whether the
  // guard refuses BEFORE any write (a refused shareable assert must never touch
  // the table) vs. lets a private assert through to SQL.
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — the WI-1564 guard must refuse first');
  }) as unknown as Sql;

  it('refuses a SHAREABLE fact on the non-federating coordination partition (loud, not stranded)', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', shareable: true, workspaceId: 'default' },
        failSql,
      ),
    ).rejects.toThrow(/WI-1564/);
  });

  it('refuses a shareable fact whose workspace resolves to the wildcard partition', async () => {
    await expect(
      assertFact(
        { scope: 'role', scopeRef: 'mug', key: 'k', body: 'b', createdBy: 'su-test', shareable: true, workspaceId: '*' },
        failSql,
      ),
    ).rejects.toThrow(/never federates/);
  });

  it('lets a hive-PRIVATE fact through the guard on any partition (reaches SQL)', async () => {
    // shareable !== true ⇒ never rides the wire ⇒ the coordination partition is
    // fine; the assert must get PAST the guard (and hit the failSql stub).
    // ttlSec is REQUIRED to reach SQL at all (facts-require-explicit-expiry-2026-09-02
    // P-001): an undeclared lifetime is refused before any other guard runs, so a
    // fixture asserting "this reaches SQL" must declare one or it proves nothing.
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', workspaceId: 'default', ttlSec: 3600 },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('validateFactScope (D-001 scoping)', () => {
  it('workspace scope is global — carries NO ref', () => {
    expect(validateFactScope('workspace', null)).toBeNull();
    expect(validateFactScope('workspace', 'papercusp')).toMatch(/no scope_ref/);
  });

  it('every other scope requires a ref', () => {
    for (const scope of ['role', 'owner', 'harness', 'work_item']) {
      expect(validateFactScope(scope, 'x')).toBeNull();
      expect(validateFactScope(scope, '')).toMatch(/requires scope_ref/);
      expect(validateFactScope(scope, null)).toMatch(/requires scope_ref/);
    }
  });

  it('rejects unknown scopes', () => {
    expect(validateFactScope('galaxy', 'x')).toMatch(/unknown scope/);
  });
});

describe('validateFactScopeRefShape (EI-22179589084262757 — an unfoldable scope_ref)', () => {
  // Every case below is a SHAPE measured in harness_shared.agent_facts on
  // 2026-09-02, not an invented one: 41 rows from 12+ independent callers whose
  // scope_ref could never match the fold selector for its scope, so the fact was
  // stored and silently unreadable.

  it('rejects a work-item id under a scope that is not work_item — the dominant real shape (33 rows)', () => {
    for (const scope of ['harness', 'owner', 'role']) {
      expect(validateFactScopeRefShape(scope, 'EI-21141007299141608')).toMatch(/not a '.*' identity/);
      expect(validateFactScopeRefShape(scope, 'WI-39450')).toMatch(/UNREADABLE/);
    }
  });

  it("names source_ref in the remedy — the diagnosed cause was provenance going into the nearest string field", () => {
    const err = validateFactScopeRefShape('harness', 'EI-20443544252779323');
    expect(err).toMatch(/source_ref/);
    expect(err).toMatch(/scope:'work_item'/);
  });

  it('rejects prose and filesystem paths (the two singleton shapes observed)', () => {
    expect(
      validateFactScopeRefShape('harness', 'EI-19453584934952289; doc-part verify-mixed-family'),
    ).toMatch(/whitespace/);
    expect(
      validateFactScopeRefShape('harness', 'packages/operator-core/lib/agent-tools/session/end.ts'),
    ).toMatch(/filesystem path/);
  });

  it('requires a work-item id when the scope IS work_item', () => {
    expect(validateFactScopeRefShape('work_item', 'papercusp')).toMatch(/keyed by a work-item id/);
    expect(validateFactScopeRefShape('work_item', 'EI-21141007299141608')).toBeNull();
  });

  it('ACCEPTS every shape the live table actually uses — this is a denylist, not an allowlist', () => {
    // Calibration: if these started failing, the guard would be refusing legitimate
    // writes, which is the expensive direction of a write-boundary refusal.
    expect(validateFactScopeRefShape('owner', 'su-54b7836d-d1b0-4ec6-8c4c-ea5b718c68c7')).toBeNull();
    expect(validateFactScopeRefShape('harness', 'papercusp')).toBeNull();
    expect(validateFactScopeRefShape('harness', 'oddsmith-hive')).toBeNull();
    expect(validateFactScopeRefShape('role', 'su')).toBeNull();
    expect(validateFactScopeRefShape('work_item', 'F-1234')).toBeNull();
    expect(validateFactScopeRefShape('workspace', null)).toBeNull();
    // An owner id form this workspace has never written must still pass: the point
    // of a denylist is that a future identity form is not refused by a stale pattern.
    expect(validateFactScopeRefShape('owner', 'cup-abc123')).toBeNull();
  });

  it('CONTROL — the accept-leg above can actually fail (an allowlist would break the fleet)', () => {
    // A guard that has never failed is a guard nobody has tested, and the accept-leg
    // is the one whose breakage is expensive: it refuses legitimate writes. This is
    // the tempting wrong implementation — allowlist the owner forms seen in the live
    // table — kept here permanently so the assertions above are demonstrably load-bearing.
    const allowlistVersion = (scope: string, ref: string): string | null =>
      scope === 'owner' && !/^su-/.test(ref) ? `'${ref}' is not a known owner id` : null;

    expect(allowlistVersion('owner', 'su-54b7836d-d1b0-4ec6-8c4c-ea5b718c68c7')).toBeNull();
    // ...but it refuses a legitimate non-`su-` owner, which the real guard admits:
    expect(allowlistVersion('owner', 'cup-abc123')).toMatch(/not a known owner id/);
    expect(validateFactScopeRefShape('owner', 'cup-abc123')).toBeNull();
  });

  it('leaves the RETRACT path able to address the existing orphans', () => {
    // The 41 bad rows can only be cleaned up if retractFact can still name them, and
    // retractFact validates with validateFactScope — which must NOT gain this check.
    expect(validateFactScope('harness', 'EI-21141007299141608')).toBeNull();
    expect(validateFactScope('harness', 'packages/operator-core/lib/agent-tools/session/end.ts')).toBeNull();
  });
});

describe('previewFactCapImpact validation parity', () => {
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — preview validation must refuse first');
  }) as unknown as Sql;

  it('rejects the same malformed scope ref as assertFact before querying', async () => {
    await expect(
      (async () => {
        const { previewFactCapImpact } = await import('./store');
        return previewFactCapImpact(
          {
            scope: 'owner',
            scopeRef: 'EI-23119165509578289',
            key: 'k',
            body: 'b',
            createdBy: 'su-test',
          },
          failSql,
        );
      })(),
    ).rejects.toThrow(/cannot be a 'owner' reference/);
  });
});

describe('EI-7463 — a caller-side scope/ref validation failure throws InvalidInputError, not a plain Error', () => {
  // The dispatcher (dispatch-stack.ts) codes InvalidInputError as `invalid_input`
  // (400) and any other thrown Error as `handler_error` (500) — so a facts:assert
  // arg mistake (omitted scope_ref for a non-workspace scope) must NOT surface as
  // a plain Error, or it inflates the tool's structural error-rate telemetry
  // (the false "tool is broken" signal this ticket fixes).
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — validation must refuse before any write');
  }) as unknown as Sql;

  it('assertFact: a missing scope_ref for scope "harness" throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'harness', key: 'k', body: 'b', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('assertFact: a missing scope_ref for scope "owner" throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'owner', key: 'k', body: 'b', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('assertFact: an empty key (post-trim) throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'workspace', key: '   ', body: 'b', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('assertFact: an empty body (post-clamp) throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'workspace', key: 'k', body: '   ', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('retractFact: a missing scope_ref for scope "role" throws InvalidInputError', async () => {
    await expect(
      retractFact({ scope: 'role', key: 'k' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('a genuinely valid assert is unaffected — still reaches SQL (the stub throw proves it)', async () => {
    await expect(
      assertFact(
        // ttlSec: P-001 requires an explicit lifetime before SQL is reachable.
        { scope: 'harness', scopeRef: 'papercusp', key: 'k', body: 'b', createdBy: 'su-test', workspaceId: 'papercusp-workspace', ttlSec: 3600 },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('resolveFactScopeRef (EI-7517 — self-scoped default)', () => {
  const defaults = { ownerId: 'su-me', harnessSlug: 'papercusp', role: 'su' };

  it('defaults an OMITTED ref for the self-scoped scopes from ctx', () => {
    expect(resolveFactScopeRef('owner', undefined, defaults)).toBe('su-me');
    expect(resolveFactScopeRef('owner', null, defaults)).toBe('su-me');
    expect(resolveFactScopeRef('owner', '  ', defaults)).toBe('su-me'); // blank counts as omitted
    expect(resolveFactScopeRef('harness', undefined, defaults)).toBe('papercusp');
    expect(resolveFactScopeRef('role', undefined, defaults)).toBe('su');
  });

  it('the defaulted owner ref then PASSES validateFactScope (the fix — no more structural error)', () => {
    // The bug: facts:assert { scope: 'owner' } with no ref returned the
    // "scope 'owner' requires scope_ref" structural error the watchdog flagged.
    expect(validateFactScope('owner', undefined)).toMatch(/requires scope_ref/);
    const filled = resolveFactScopeRef('owner', undefined, defaults);
    expect(validateFactScope('owner', filled)).toBeNull();
  });

  it('an EXPLICIT ref always wins over the ctx default', () => {
    expect(resolveFactScopeRef('owner', 'su-other', defaults)).toBe('su-other');
    expect(resolveFactScopeRef('harness', 'other-harness', defaults)).toBe('other-harness');
    expect(resolveFactScopeRef('role', 'mug', defaults)).toBe('mug');
  });

  it('leaves workspace ref-less and does NOT invent a work_item ref', () => {
    expect(resolveFactScopeRef('workspace', undefined, defaults)).toBeUndefined();
    // work_item has no caller-context default — still requires an explicit id.
    expect(resolveFactScopeRef('work_item', undefined, defaults)).toBeUndefined();
    expect(validateFactScope('work_item', resolveFactScopeRef('work_item', undefined, defaults))).toMatch(
      /requires scope_ref/,
    );
  });

  it('falls back to the passed ref when a ctx default is missing', () => {
    expect(resolveFactScopeRef('harness', undefined, { ownerId: 'su-me' })).toBeUndefined();
    expect(resolveFactScopeRef('role', null, { ownerId: 'su-me' })).toBeNull();
  });
});

describe('renderFactsFold', () => {
  const fact = (over: Partial<AgentFact>): AgentFact => ({
    scope: 'role',
    scopeRef: 'mug',
    key: 'k',
    body: 'WI-1439 is owner-residue — exclude from the placeable frontier',
    confidence: null,
    // P-008 (b), migration 690 — the three columns AgentFact gained. Spelled out
    // rather than defaulted so this fixture keeps mirroring a real persisted row.
    kind: null,
    dependsOn: [],
    claim: null,
    // P-018, migration 692 — same reason: spelled out so the fixture mirrors a
    // real persisted row rather than relying on a default.
    enforcement: null,
    sourceRef: 'WI-1574',
    audienceScope: null,
    sourceProvenance: null,
    createdBy: 'su-test',
    updatedAt: new Date(0).toISOString(),
    expiresAt: new Date(3 * 86_400_000).toISOString(),
    ...over,
  });

  // P-004 / D-006. The fold is `ORDER BY updated_at DESC LIMIT 12` under a header
  // that reads "### Standing facts", so without a truncation line a 2.4% sample is
  // byte-indistinguishable from a complete corpus (measured 2026-09-02: scope
  // `workspace` held 495 fold-eligible facts and showed 12). These three cases pin
  // the DISCLOSURE, not the ordering — D-006 rules recency correct.
  describe('P-004 / D-006: a truncated fold says so', () => {
    it('states the shortfall, per scope, with the read that returns the rest', () => {
      const out = renderFactsFold([fact({})], 0, [
        { scope: 'workspace', scopeRef: null, shown: 12, total: 495, truncated: true },
        { scope: 'harness', scopeRef: 'papercusp', shown: 12, total: 366, truncated: true },
      ]);
      expect(out).toContain('TRUNCATED');
      // The NUMBERS are the point — a bare "some were omitted" leaves the reader
      // unable to tell 12-of-13 from 12-of-495.
      expect(out).toContain('workspace showed 12 of 495');
      expect(out).toContain('harness:papercusp showed 12 of 366');
      // The specific wrong inference this exists to block, and the way out of it.
      expect(out).toContain('ABSENCE');
      expect(out).toContain('facts:list');
    });

    it('says NOTHING when every scope fit — silence must mean census, not "not computed"', () => {
      const out = renderFactsFold([fact({})], 0, [
        { scope: 'workspace', scopeRef: null, shown: 1, total: 1, truncated: false },
      ]);
      expect(out).not.toContain('TRUNCATED');
      expect(out).toContain('### Standing facts');
    });

    it('names ONLY the scopes that truncated, never the ones that fit', () => {
      const out = renderFactsFold([fact({})], 0, [
        { scope: 'workspace', scopeRef: null, shown: 12, total: 495, truncated: true },
        { scope: 'owner', scopeRef: 'su-quiet', shown: 3, total: 3, truncated: false },
      ]);
      expect(out).toContain('workspace showed 12 of 495');
      expect(out).not.toContain('su-quiet');
    });
  });

  it('renders one deterministic line per fact with scope, expiry and source', () => {
    const out = renderFactsFold([fact({})], 0);
    expect(out).toContain('### Standing facts');
    // A census-less call is the pre-D-006 signature and must stay silent rather
    // than claim completeness it was never given evidence for.
    expect(out).not.toContain('TRUNCATED');
    expect(out).toContain('[role:mug] WI-1439 is owner-residue');
    expect(out).toContain('expires ~3d');
    expect(out).toContain('src WI-1574');

    const lapsedWall = renderFactsFold(
      [fact({ key: 'wall:owner-action', expiresAt: '2026-07-01T00:00:00.000Z' })],
      Date.parse('2026-07-02T00:00:00.000Z'),
    );
    expect(lapsedWall).toContain('TTL lapsed — remains active until retracted');
  });

  it('workspace-scoped facts render without a ref; empty set renders nothing', () => {
    const out = renderFactsFold([fact({ scope: 'workspace', scopeRef: null, sourceRef: null })], 0);
    expect(out).toContain('[workspace]');
    expect(out).not.toContain('src ');
    expect(renderFactsFold([])).toBe('');
  });

  it('P-007: renders the audience tag and the verified provenance quote', () => {
    const out = renderFactsFold(
      [
        fact({
          audienceScope: 'fleet:backend',
          sourceRef: 'msg:m-1',
          sourceProvenance: { kind: 'msg', verified: true, quote: 'origin words', verifiedAt: 't' },
        }),
      ],
      0,
    );
    expect(out).toContain('[role:mug ⊸fleet:backend]');
    expect(out).toContain('src msg:m-1 ✓ "origin words"');
  });

  it('EI-20191740437408337: renders a moving measurement as an explicit snapshot', () => {
    const out = renderFactsFold(
      [
        fact({
          measurement: { subjectVolatile: true, measuredAt: '2026-08-11T20:50:00.000Z' },
        }),
      ],
      Date.parse('2026-08-11T20:50:00.000Z'),
    );
    expect(out).toContain('SNAPSHOT');
    expect(out).toContain('subject may still be changing');
    expect(out).toContain('re-measure before acting');
    expect(out).toContain('2026-08-11T20:50:00.000Z');
  });
});

describe('volatile measurement validation (EI-20191740437408337)', () => {
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — snapshot validation must refuse before any write');
  }) as unknown as Sql;

  it('requires measuredAt when subjectVolatile is true', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'moving', body: 'currently 4 open', createdBy: 'su-test', subjectVolatile: true },
        failSql,
      ),
    ).rejects.toThrow(/requires measuredAt/);
  });

  /**
   * P-006 / D-011 — the boundary MOVED for two of the three volatility rules.
   *
   * This suite is a VALIDATION-BOUNDARY suite: `failSql` throws a distinctive sentinel if
   * a write is attempted, so "rejects with the sentinel" is how a case proves it PASSED
   * validation. What is written (the clamped ttl, the `normalized` receipt) is asserted in
   * store.integration.test.ts against a real row, which is the only place those mean
   * anything.
   *
   * WHY THESE TWO CHANGED: a volatile snapshot is one intent spread over three co-varying
   * fields, and any two-of-three used to be a hard refusal that stored NOTHING. Measured:
   * 41.0% of 7,639 calls rejected across 576 distinct agents in 14 days, with 149 distinct
   * agents hitting the TTL rule alone and five separate work-items filed about it.
   */
  it('CLAMPS a long TTL rather than refusing the write (D-011)', async () => {
    await expect(
      assertFact(
        {
          scope: 'workspace',
          key: 'moving',
          body: 'currently 4 open',
          createdBy: 'su-test',
          subjectVolatile: true,
          measuredAt: '2026-08-11T20:50:00.000Z',
          ttlSec: FACT_VOLATILE_MAX_TTL_SEC + 1,
        },
        failSql,
      ),
      // Reaching SQL is the assertion: validation let it through. Clamping only ever
      // SHORTENS a TTL, so it enforces the same ceiling the refusal did — while storing
      // the caller's fact instead of discarding it.
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });

  it('INFERS subjectVolatile from a supplied measuredAt rather than refusing (D-011)', async () => {
    // 385 rejections from 192 DISTINCT agents. You do not stamp a sample time for a
    // non-sample, so the intent is unambiguous and deterministically repairable.
    await expect(
      assertFact(
        {
          scope: 'workspace',
          key: 'moving',
          body: 'currently 4 open',
          createdBy: 'su-test',
          measuredAt: '2026-08-11T20:50:00.000Z',
          ttlSec: 3600, // P-001: an explicit lifetime is required to reach SQL.
        },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });

  it('STILL refuses subjectVolatile:true with no measuredAt — the one repair that would lie', async () => {
    // Deliberately NOT normalized. The only available repair is measuredAt = now(), which
    // would stamp a sample of unknown age as fresh — the exact misreading the field exists
    // to prevent. Correct to refuse even though it costs ~44 agents.
    await expect(
      assertFact(
        { scope: 'workspace', key: 'moving', body: 'currently 4 open', createdBy: 'su-test', subjectVolatile: true },
        failSql,
      ),
    ).rejects.toThrow(/requires measuredAt/);
  });

  it('STILL refuses a future measuredAt — clock skew is signal, not noise', async () => {
    await expect(
      assertFact(
        {
          scope: 'workspace',
          key: 'moving',
          body: 'currently 4 open',
          createdBy: 'su-test',
          subjectVolatile: true,
          measuredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        failSql,
      ),
    ).rejects.toThrow(
      /future.*server-aligned timestamp.*retry with that measuredAt.*subjectVolatile:true and no measuredAt/,
    );
  });

  it('parses only the complete, marked measurement shape', () => {
    expect(parseFactMeasurement({ subjectVolatile: true, measuredAt: '2026-08-11T20:50:00Z' })).toEqual({
      subjectVolatile: true,
      measuredAt: '2026-08-11T20:50:00.000Z',
    });
    expect(parseFactMeasurement({ measuredAt: '2026-08-11T20:50:00Z' })).toBeNull();
    expect(parseFactMeasurement({ subjectVolatile: true, measuredAt: 'not-a-date' })).toBeNull();
  });
});

// ── coord-authority-hardening-2026-07-11 P-007 (H3+C) — the pure halves ─────────

describe('validateAudienceScope (P-007 v1 grammar)', () => {
  it('accepts absent/blank (unrestricted) and fleet:<slug>', () => {
    expect(validateAudienceScope(undefined)).toBeNull();
    expect(validateAudienceScope(null)).toBeNull();
    expect(validateAudienceScope('')).toBeNull();
    expect(validateAudienceScope('   ')).toBeNull();
    expect(validateAudienceScope('fleet:p2p-git')).toBeNull();
    expect(validateAudienceScope('fleet:Backend_2.x')).toBeNull();
  });

  it('rejects unknown grammars LOUDLY — a stored-but-unmatchable audience would hide the fact from everyone', () => {
    for (const bad of ['fleet:', 'squad:x', 'fleet:@nope', 'owner:su-1', 'fleet:x y', 'FLEETbackend']) {
      expect(validateAudienceScope(bad)).toMatch(/grammar/);
    }
  });
});

describe('assertFact audienceScope guard (P-007 — refuse before any write)', () => {
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — validation must refuse before any write');
  }) as unknown as Sql;

  it('an unknown audience grammar throws InvalidInputError (never stored unmatchable)', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', audienceScope: 'squad:x' },
        failSql,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('a valid fleet audience passes the guard (reaches SQL)', async () => {
    await expect(
      assertFact(
        // ttlSec: P-001 requires an explicit lifetime before SQL is reachable.
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', audienceScope: 'fleet:backend', ttlSec: 3600 },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('parseFactSourceProvenance (defensive jsonb round-trip read)', () => {
  it('round-trips a valid stamp and drops unknown extras', () => {
    expect(
      parseFactSourceProvenance({
        kind: 'owner-turn',
        verified: true,
        quote: 'the owner words',
        label: 'owner turn 2026-07-11T00:00:00Z',
        verifiedAt: '2026-07-11T00:00:01Z',
        forged: 'junk',
      }),
    ).toEqual({
      kind: 'owner-turn',
      verified: true,
      quote: 'the owner words',
      label: 'owner turn 2026-07-11T00:00:00Z',
      verifiedAt: '2026-07-11T00:00:01Z',
    });
  });

  it('accepts raw JSON text too (a custom postgres.js `types` config returns jsonb as text)', () => {
    expect(
      parseFactSourceProvenance('{"kind":"msg","verified":true,"quote":"q","verifiedAt":"t"}'),
    ).toEqual({ kind: 'msg', verified: true, quote: 'q', verifiedAt: 't' });
    expect(parseFactSourceProvenance('not json {')).toBeNull();
  });

  it('rejects absent/malformed/forged shapes → null, never throws', () => {
    for (const junk of [
      null,
      undefined,
      'string',
      42,
      {},
      { kind: 'god-mode', verified: true, verifiedAt: 't' }, // forged kind
      { kind: 'msg', verified: 'yes', verifiedAt: 't' }, // non-bool verified
      { kind: 'msg', verified: true }, // missing verifiedAt
    ]) {
      expect(parseFactSourceProvenance(junk)).toBeNull();
    }
  });
});

describe('renderFactSrc (P-007 provenance-hydrated src)', () => {
  const base = { sourceRef: 'msg:m-1' };

  it('no stamp ⇒ the plain sourceRef (legacy/free-text unchanged); no source at all ⇒ empty', () => {
    expect(renderFactSrc({ sourceRef: 'a-plan-slug', sourceProvenance: null })).toBe('a-plan-slug');
    expect(renderFactSrc({ sourceRef: null, sourceProvenance: null })).toBe('');
  });

  it('verified with quote ⇒ `<ref> ✓ "<quote>"`; verified quote-less ⇒ label fallback', () => {
    const stamp: FactSourceProvenance = { kind: 'msg', verified: true, quote: 'origin words', verifiedAt: 't' };
    expect(renderFactSrc({ ...base, sourceProvenance: stamp })).toBe('msg:m-1 ✓ "origin words"');
    expect(
      renderFactSrc({
        sourceRef: 'WI-4172',
        sourceProvenance: { kind: 'work-item', verified: true, label: 'WI-4172 [feature/wip]', verifiedAt: 't' },
      }),
    ).toBe('WI-4172 ✓ WI-4172 [feature/wip]');
  });

  it('unverified renders LOUDLY with the error', () => {
    expect(
      renderFactSrc({ ...base, sourceProvenance: { kind: 'msg', verified: false, error: 'not_found', verifiedAt: 't' } }),
    ).toBe('msg:m-1 ✗unverified (not_found)');
    expect(
      renderFactSrc({ ...base, sourceProvenance: { kind: 'msg', verified: false, verifiedAt: 't' } }),
    ).toBe('msg:m-1 ✗unverified');
  });
});

// ── code-run-self-state-adoption-2026-07-03 P-007: truncate-not-reject ────────────────

import { clampFactBody, FACT_BODY_MAX_CHARS } from './store';

describe('clampFactBody — over-cap bodies truncate instead of rejecting (P-007)', () => {
  it('keeps an in-cap body verbatim (trimmed)', () => {
    expect(clampFactBody('  a tight conclusion  ')).toBe('a tight conclusion');
  });

  it('truncates an over-cap body to exactly the cap with a visible ellipsis', () => {
    const out = clampFactBody('x'.repeat(FACT_BODY_MAX_CHARS + 100));
    expect(out.length).toBe(FACT_BODY_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('at-cap body passes untouched (boundary)', () => {
    const exact = 'y'.repeat(FACT_BODY_MAX_CHARS);
    expect(clampFactBody(exact)).toBe(exact);
  });

  // EI-18681984560352579 / mig 664: recurrence guard the bug report asked for —
  // no accepted (in-cap) write is ever silently altered. clampFactBody is the
  // ONLY mutation the store applies to `body` before it lands in Postgres (the
  // DB CHECK char_length(body) <= FACT_BODY_MAX_CHARS is the storage backstop,
  // kept in sync via migration 664), so byte-identical here IS the round-trip
  // guarantee facts:list must honor.
  it('any body at or under the cap round-trips byte-identical — no accepted write is ever silently altered', () => {
    for (const len of [1, 50, 499, 500, 501, 900, FACT_BODY_MAX_CHARS - 1, FACT_BODY_MAX_CHARS]) {
      // .trim() up front — clampFactBody trims too, and a raw slice can land on
      // trailing whitespace that would make the byte-identity check spurious.
      const body = 'a discriminator rule with a verdict clause. '.repeat(Math.ceil(len / 46)).slice(0, len).trim();
      expect(clampFactBody(body)).toBe(body);
    }
  });
});

describe('excerptEvictedBody (EI-21393210182770949)', () => {
  it('returns a short body whole and does not mark it truncated', () => {
    const body = 'a peer measured this and it is not yet acted on';
    expect(excerptEvictedBody(body)).toEqual({ bodyExcerpt: body, bodyTruncated: false });
  });

  it('marks a long body truncated and caps it at the excerpt budget', () => {
    const body = 'x'.repeat(FACT_EVICTION_EXCERPT_CHARS + 500);
    const out = excerptEvictedBody(body);
    expect(out.bodyTruncated).toBe(true);
    expect(out.bodyExcerpt).toHaveLength(FACT_EVICTION_EXCERPT_CHARS);
    // The point of the flag: a reader must be able to tell an excerpt from a
    // whole body, or they will act on a partial fact believing it complete.
    expect(body.startsWith(out.bodyExcerpt)).toBe(true);
  });

  it('BOUNDARY: a body exactly at the budget is whole, not truncated', () => {
    // The off-by-one that would silently mark complete bodies as partial and
    // send every reader on a needless facts:list round-trip.
    const exact = 'y'.repeat(FACT_EVICTION_EXCERPT_CHARS);
    expect(excerptEvictedBody(exact)).toEqual({ bodyExcerpt: exact, bodyTruncated: false });

    const oneOver = 'y'.repeat(FACT_EVICTION_EXCERPT_CHARS + 1);
    expect(excerptEvictedBody(oneOver).bodyTruncated).toBe(true);
  });

  it('degrades a null/undefined body to an empty excerpt rather than throwing', () => {
    // An eviction receipt is the wrong place to discover a NOT NULL column
    // stopped being NOT NULL.
    expect(excerptEvictedBody(null)).toEqual({ bodyExcerpt: '', bodyTruncated: false });
    expect(excerptEvictedBody(undefined)).toEqual({ bodyExcerpt: '', bodyTruncated: false });
  });
});
