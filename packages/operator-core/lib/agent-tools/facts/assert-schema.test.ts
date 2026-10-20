import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatIssues } from '@papercusp/tooldef';

import { schemaToText } from '../../cupboard/tools-discovery';
import assertTool from './assert';
import { FACT_MAX_SUPERSEDES, FACT_VOLATILE_MAX_TTL_SEC } from '../../agent-facts/store';

const base = {
  scope: 'owner',
  key: 'schema-probe',
  body: 'schema probe',
  // Every ordinary fixture declares a bounded lifetime. The no-lifetime path
  // is covered explicitly below so unrelated schema-contract tests stay about
  // the field they are exercising.
  ttlSec: 60,
};

describe('facts:assert settledBy modality contract', () => {
  it('accepts settledBy only on an undecidable fact and requires it there', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'undecidable',
        settledBy: 'a concrete validation probe',
      }).success,
    ).toBe(true);
    expect(assertTool.args.safeParse({ ...base, kind: 'undecidable' }).success).toBe(false);
  });

  it('rejects settledBy on a conclusion, assumption, convention, or undeclared modality', () => {
    for (const kind of ['conclusion', 'assumption', 'convention', undefined]) {
      expect(
        assertTool.args.safeParse({
          ...base,
          ...(kind ? { kind } : {}),
          settledBy: 'a probe that would settle an open question',
        }).success,
        `kind=${kind ?? 'omitted'}`,
      ).toBe(false);
    }
    expect(assertTool.args.safeParse({ ...base }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...base, kind: 'conclusion' }).success).toBe(true);
  });

  it('publishes all four modalities and states the settledBy coupling (EI-22064465906366039)', () => {
    // Replaces an assertion that the schema carried TWO UNION BRANCHES. That
    // shape was the defect, not the contract: the projection flattened the
    // 3x2 union and published `kind: { const: 'undecidable' }`, advertising the
    // one modality as the only legal value (EI-21968656043579751) while the
    // runtime accepted all four. The contract worth guarding is the OUTCOME —
    // every modality visible, and the coupling stated where a caller reads it.
    const json = z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, { enum?: unknown[]; const?: unknown; description?: string }>;
      required?: string[];
    };
    const props = json.properties ?? {};

    expect(props.kind?.enum).toEqual(
      expect.arrayContaining(['conclusion', 'assumption', 'convention', 'undecidable']),
    );
    // The regression that made this test necessary: a single modality published
    // as the only permissible one.
    expect(props.kind?.const).toBeUndefined();
    // The coupling has to be READABLE, since it is no longer structural.
    expect(props.settledBy?.description ?? '').toMatch(/undecidable/i);
    expect(props.kind?.description ?? '').toMatch(/undecidable/i);
    // settledBy is conditionally required, so it must not be unconditionally so.
    expect(json.required ?? []).not.toContain('settledBy');
    expect(JSON.stringify(props.settledBy)).toContain('x-papercusp-call-constraint');
    expect(JSON.stringify(props.settledBy)).toContain(
      "required when kind:'undecidable'; refused for every other kind.",
    );
  });

  it('rejects ONE mistake with ONE targeted issue, never a six-branch dump (EI-22064465906366039)', () => {
    // The reported failure mode: a 3x2 z.union answered a single mistake with
    // every branch's unmet requirements — measured at 6 distinct complaints,
    // mutually contradictory (a correct kind:'undecidable' was told it must be
    // one of conclusion|assumption|convention, and elsewhere kind must be
    // 'undecidable' while settledBy must be `never`). Agents obeyed the dump and
    // landed in the next rejection; facts:assert carried 26.4% invalid_input.
    const single = [
      { input: { ...base, kind: 'undecidable' }, path: 'settledBy' },
      { input: { ...base, kind: 'conclusion', settledBy: 'a probe' }, path: 'settledBy' },
      { input: { ...base, shareable: true }, path: 'harness' },
    ] as const;

    for (const { input, path } of single) {
      const result = assertTool.args.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path.join('.')).toBe(path);
      // No issue may contradict a field the caller already got right.
      const text = JSON.stringify(result.error.issues);
      expect(text).not.toMatch(/expected one of "conclusion"/);
      expect(text).not.toMatch(/expected never/);
    }
  });

});

describe('facts:assert shareable federation contract', () => {
  it('requires a federation harness, while preserving explicit harness scopeRef', () => {
    expect(assertTool.args.safeParse({ ...base, shareable: true }).success).toBe(false);
    expect(assertTool.args.safeParse({ ...base, shareable: true, harness: 'papercusp' }).success).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        scope: 'harness',
        scopeRef: 'papercusp',
        shareable: true,
      }).success,
    ).toBe(true);
    expect(assertTool.args.safeParse({ ...base, shareable: false }).success).toBe(true);
  });

  it('publishes the shareable discriminator and harness prerequisite', () => {
    // EI-22064465906366039: the prerequisite used to be published as a
    // branch-local `const: true` override plus a branch-local harness
    // description. With the root union retired, the same contract is carried by
    // the two field descriptions that a caller actually reads — which is where
    // it was needed, since the branch form was flattened away in projection.
    const props = (z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, { description?: string; type?: string }>;
    }).properties ?? {};
    expect(props.shareable?.type).toBe('boolean');
    expect(props.shareable?.description ?? '').toMatch(/harness/i);
    expect(props.harness?.description ?? '').toMatch(/shareable/i);
  });
});

describe('facts:assert convention enforcement contract (EI-25333926594437978)', () => {
  it('rejects conditionally invalid tiers at the input schema', () => {
    const invalid = [
      { ...base, kind: 'convention', enforcement: { tier: 'detector' } },
      { ...base, kind: 'convention', enforcement: { tier: 'gate', reviewBy: '2026-12-01' } },
      { ...base, kind: 'convention', enforcement: { tier: 'detector', floor: 0.6 } },
      { ...base, kind: 'conclusion', enforcement: { tier: 'detector', floor: 0.6, reviewBy: '2026-12-01' } },
    ];

    for (const input of invalid) {
      const parsed = assertTool.args.safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(parsed.error.issues).toHaveLength(1);
      expect(parsed.error.issues[0]?.path).toEqual(['enforcement']);
    }
  });

  it('accepts the structural tier without measured fields and a complete detector tier', () => {
    expect(
      assertTool.args.safeParse({ ...base, kind: 'convention', enforcement: { tier: 'structural' } }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'convention',
        enforcement: { tier: 'detector', floor: 0.6, reviewBy: '2026-12-01' },
      }).success,
    ).toBe(true);
  });
});

describe('facts:assert measurement input compatibility', () => {
  it('accepts the persisted/read measurement object alongside a conclusion', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'conclusion',
        confidence: 'verified',
        recheck: { probe: 'read the fact', falsifier: 'the fact is no longer true' },
        measurement: {
          subjectVolatile: true,
          measuredAt: '2026-08-30T03:19:00.000Z',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an incomplete measurement object instead of silently flattening it', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'conclusion',
        measurement: { measuredAt: '2026-08-30T03:19:00.000Z' },
      }).success,
    ).toBe(false);
  });
});

describe('facts:assert supersedes contract', () => {
  it('publishes a bounded sibling-key list on every modality branch', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        supersedes: Array.from({ length: FACT_MAX_SUPERSEDES }, (_, i) => `old-${i}`),
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        supersedes: Array.from({ length: FACT_MAX_SUPERSEDES + 1 }, (_, i) => `old-${i}`),
      }).success,
    ).toBe(false);
    expect(assertTool.args.safeParse({ ...base, supersedes: [''] }).success).toBe(false);
  });

  it('documents same-scope atomic retirement and the actual-change receipt', () => {
    const json = JSON.stringify(z.toJSONSchema(assertTool.args as never));
    expect(json).toContain('supersedes');
    expect(json).toContain('SAME workspace/scope/ref');
    expect(json).toContain('receipt reports the keys actually retired');
  });
});

describe('facts:assert cap-admission contract', () => {
  it('documents refusal of destructive cross-author verified eviction and exempt slots', () => {
    const publishedProps = (z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, { description?: string }>;
    }).properties ?? {};
    const dryRun = publishedProps.dryRun?.description;

    expect(dryRun).toMatch(/refused before write/i);
    expect(dryRun).toMatch(/another author.*verified fact/i);
    expect(dryRun).toMatch(/conventions and typed safety slots take no cap seat/i);
  });
});

/**
 * EI-21949855462339968 — the volatile-measurement contract must live in the SCHEMA,
 * and the schema's prose must state the verdict the validator actually applies.
 *
 * D-011 turned two of the three volatile rules into repairs (measuredAt alone INFERS
 * subjectVolatile; an over-cap ttlSec is CLAMPED and disclosed) and left exactly one
 * refusal. The published `ttlSec` text was never updated with it, so the schema told
 * callers an over-cap volatile TTL "must be ≤900 seconds" while the store quietly
 * clamped and accepted it — a described refusal the validator does not perform, which
 * is how a legal call looks illegal. Meanwhile the one REAL refusal lived only in the
 * store, so `args.safeParse` accepted input the write rejected and `dryRun:true`
 * forecast `ok:true` for a write that cannot succeed.
 *
 * These pins hold both directions: what is REFUSED must parse as refused, and what is
 * REPAIRED must parse as accepted.
 */
describe('facts:assert volatile-measurement contract', () => {
  const volatileBase = { ...base, key: 'volatile-probe' };

  it('REFUSES subjectVolatile:true without measuredAt at the schema, not only at the write', () => {
    const parsed = assertTool.args.safeParse({ ...volatileBase, subjectVolatile: true });
    expect(parsed.success).toBe(false);
    // Attributed to the missing field, and teaching what the store teaches, so
    // whichever layer refuses reads identically to the caller.
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    expect(issue?.path).toEqual(['measuredAt']);
    expect(issue?.message).toMatch(/subjectVolatile:true requires measuredAt/);
    expect(issue?.message).toMatch(/NOT defaulted to now\(\)/);
  });

  it('accepts the timestamp through either the flat field or the measurement alias', () => {
    const measuredAt = '2026-08-31T11:00:00Z';
    const { ttlSec: _ordinaryTtl, ...withoutLifetime } = volatileBase;
    expect(assertTool.args.safeParse({ ...withoutLifetime, subjectVolatile: true, measuredAt }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...volatileBase, subjectVolatile: true, measuredAt }).success).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...volatileBase,
        subjectVolatile: true,
        measurement: { subjectVolatile: true, measuredAt },
      }).success,
    ).toBe(true);
  });

  it('leaves every D-011 REPAIRED combination accepted — a repair is not a refusal', () => {
    const measuredAt = '2026-08-31T11:00:00Z';
    // Over-cap TTL on a volatile fact is CLAMPED by the store, so the schema must not
    // refuse it. This is the pin that catches the drifted `ttlSec` prose.
    expect(
      assertTool.args.safeParse({
        ...volatileBase,
        subjectVolatile: true,
        measuredAt,
        ttlSec: FACT_VOLATILE_MAX_TTL_SEC * 4,
      }).success,
    ).toBe(true);
    // measuredAt alone INFERS subjectVolatile — accepted, never refused.
    expect(assertTool.args.safeParse({ ...volatileBase, measuredAt }).success).toBe(true);
    // subjectVolatile:false is an ordinary fact and needs no timestamp.
    expect(assertTool.args.safeParse({ ...volatileBase, subjectVolatile: false }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...volatileBase }).success).toBe(true);
  });

  it('publishes the clamp verdict on ttlSec instead of a refusal it does not perform', () => {
    const publishedProps = (z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, { description?: string }>;
    }).properties ?? {};
    const describedOn = (field: string) => publishedProps[field]?.description ?? '';

    const ttlSec = describedOn('ttlSec');
    expect(ttlSec).toMatch(/clamped/i);
    expect(ttlSec).toContain(String(FACT_VOLATILE_MAX_TTL_SEC));
    // The drifted claim: an over-cap volatile TTL described as forbidden while the
    // store accepted it. Nothing here may assert that refusal again.
    expect(ttlSec).not.toMatch(/must be\s*(≤|<=)/i);

    // The one real refusal stays stated AS the only one, on the field that carries
    // it — and beside it, the clamp, so the two verdicts are never conflated again.
    // (facts-disclosure.test.ts separately pins the requirement + inference wording.)
    const subjectVolatile = describedOn('subjectVolatile');
    expect(subjectVolatile).toMatch(/hard refusal/i);
    expect(subjectVolatile).toMatch(/clamped/i);

    const ttlSecSchema = publishedProps.ttlSec as Record<string, unknown>;
    expect(ttlSecSchema['x-papercusp-call-constraint']).toContain(
      `subjectVolatile:true or measuredAt is supplied, ttlSec>${FACT_VOLATILE_MAX_TTL_SEC} is clamped`,
    );
    expect(assertTool.args.safeParse({
      ...volatileBase,
      measuredAt: '2026-08-31T11:00:00Z',
      ttlSec: FACT_VOLATILE_MAX_TTL_SEC * 4,
    }).success).toBe(true);
  });
});

describe('facts:assert TTL spelling contract', () => {
  it('publishes only ttlSec and rejects the legacy ttlDays key as unknown', () => {
    const publishedProps = (z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, { description?: string }>;
    }).properties ?? {};
    expect(publishedProps.ttlSec).toBeDefined();
    expect(publishedProps.ttlDays).toBeUndefined();

    const parsed = assertTool.args.safeParse({ ...base, ttlDays: 7 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = formatIssues(parsed.error.issues);
    expect(message).toMatch(/ttlDays/i);
    expect(publishedProps.ttlSec?.description ?? '').toMatch(/ttlSec/i);
  });

  it('documents that ordinary facts need an explicit lifetime when confidence is omitted', () => {
    const publishedProps = (z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, { description?: string }>;
    }).properties ?? {};
    const confidence = publishedProps.confidence?.description ?? '';

    expect(confidence).toMatch(/ordinary write still needs an explicit ttlSec/i);
    expect(confidence).toMatch(/provisional.*short TTL/i);
    // The old description called an omitted confidence an "ordinary TTL", which
    // contradicted validateFactLifetime's refusal of an undeclared lifetime.
    expect(confidence).not.toMatch(/renders unbadged, ordinary TTL/i);
  });

  it('publishes the conditional lifetime rule beside the optional ttlSec field', () => {
    const json = z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const compact = schemaToText(json) ?? '';

    // The field is structurally optional because conventions, typed safety
    // keys, and provisional/suspected claims have other declared lifetime
    // rules. Preserve that shape while making the verified-conclusion case
    // explicit in the callable schema instead of leaving it only in prose.
    expect(json.properties?.ttlSec).toBeDefined();
    expect(json.required ?? []).not.toContain('ttlSec');
    expect(compact).toContain('constraint:$ (Declare exactly one lifetime');
    expect(compact).toContain('ordinary facts, including verified conclusions, require ttlSec');
    expect(compact).toContain('ttlSec?:integer');
  });

  it('REFUSES an ordinary verified fact without a declared lifetime at schema parse', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'owner',
      key: 'undeclared-lifetime',
      body: 'a verified conclusion with no expiry choice',
      confidence: 'verified',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatIssues(parsed.error.issues)).toMatch(/there is no default any more/i);
    expect(formatIssues(parsed.error.issues)).toMatch(/ttlSec/);
  });

  it('explains why a permanent conclusion is refused and accepts its bounded form', () => {
    const conclusion = { ...base, kind: 'conclusion' as const, confidence: 'verified' as const };
    const parsed = assertTool.args.safeParse({ ...conclusion, ttlSec: undefined, permanent: true });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatIssues(parsed.error.issues)).toMatch(/permanent:true/i);
    }
    expect(assertTool.args.safeParse(conclusion).success).toBe(true);

    const schema = schemaToText(z.toJSONSchema(assertTool.args as never)) ?? '';
    expect(schema).toContain('permanent:true is allowed only for conventions/typed keys');
    expect(schema).toContain('ordinary cap refuses at its ceiling instead of evicting an incumbent');
    expect(schema).not.toContain('LEAST evictable row');
  });

  it('mirrors the store lifetime exceptions and slot normalization', () => {
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        key: 'convention-without-ttl',
        body: 'a standing convention',
        kind: 'convention',
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        key: 'dead-end-without-ttl',
        body: 'a failed approach',
        slot: 'dead-end',
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        key: 'provisional-without-ttl',
        body: 'a single observation',
        confidence: 'provisional',
      }).success,
    ).toBe(true);
  });
});

/**
 * EI-22057520151022793 — a private, undecidable work_item fact missing `settledBy`
 * was reported as "shareable: Invalid input: expected true; settledBy: Invalid
 * input: expected string, received undefined". Both clauses come from the
 * FIRST-listed union branch (shareableUndecidable), which the caller never meant:
 * they sent `shareable:false`, which is only legal on the private branches. Every
 * branch of this 6-way union fails at the SAME shallow path-depth for this input,
 * so the old "deepest branch, ties keep the first" rule fell through to raw
 * declaration order and surfaced the WRONG branch's issues — a caller asking for a
 * private fact was told to make it shareable, which has nothing to do with their
 * one real mistake (the missing settledBy). See @papercusp/tooldef's
 * `bestUnionBranch` (standard-schema.ts) for the general fix: on a depth tie,
 * prefer the branch with fewer issues (a closer match) before falling back to
 * declaration order.
 */
describe('facts:assert union branch selection on a private undecidable fact (EI-22057520151022793)', () => {
  it('reports ONLY the missing settledBy for a private (shareable:false) undecidable fact, never the unrelated shareable mismatch', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'work_item',
      scopeRef: 'EI-22057520151022793',
      harness: 'papercusp',
      key: 'schema-probe-private-undecidable',
      body: 'schema probe',
      kind: 'undecidable',
      shareable: false,
      // settledBy deliberately omitted — the caller's one real mistake.
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatIssues(parsed.error.issues);
      expect(msg).toContain('settledBy');
      // The regression: the shareable-federation branch's irrelevant complaint
      // must never surface for a caller who explicitly asked for shareable:false.
      expect(msg).not.toContain('shareable');
    }
  });

  it('still requires shareable:true (and a federation harness) when the caller actually wants federation', () => {
    // Sanity check in the other direction: this fix must not make the
    // shareable-federation branch unreachable for callers who DO want it.
    expect(
      assertTool.args.safeParse({
        scope: 'work_item',
        scopeRef: 'EI-22057520151022793',
        key: 'schema-probe-shareable-undecidable',
        body: 'schema probe',
        ttlSec: 60,
        kind: 'undecidable',
        shareable: true,
        settledBy: 'a concrete validation probe',
        harness: 'papercusp',
      }).success,
    ).toBe(true);
  });
});

/**
 * EI-22050255299103531 (legacy `ttlDays` on an owner-fact correction) and
 * EI-22063684320590166 (documented `source_ref` on a workspace fact) are the SAME
 * defect reported twice: a caller sends an otherwise-valid private fact carrying one
 * key this schema does not have, and every branch of the 6-way union fails. The
 * branch that matched everything except that key complains about exactly one thing —
 * the key — but Zod records an `unrecognized_keys` name in `keys` and leaves `path`
 * empty, so it scored path-depth 0 and the "deepest branch wins" rule discarded it in
 * favour of the federation branch's own unmet requirements. Both reporters saw
 * "harness: expected string; shareable: expected true; Unrecognized key: <theirs>" —
 * which reads as an instruction to add federation fields they never wanted, with the
 * one actionable word buried last. EI-22063684320590166 asked for precisely the
 * outcome asserted here: "report only the unknown field". Fixed generally in
 * @papercusp/tooldef's `bestUnionBranch` (standard-schema.ts) by scoring an
 * unrecognized key at the depth of the key it names.
 *
 * NOTE the umbrella these were filed under (EI-22072457901556194) frames them as
 * documented ALIASES that validators fail to implement. They are not: `source_ref`
 * and `ttlDays` are genuinely not part of this schema, and the canonical `sourceRef`
 * and `ttlSec` work. The defect was never the rejection — it was that the rejection
 * pointed at the wrong branch. Adding the aliases would have been the wrong fix.
 */
describe('facts:assert reports a stray key instead of another branch (EI-22050255299103531, EI-22063684320590166)', () => {
  it('names only the unrecognized source_ref on an otherwise valid workspace fact', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'workspace',
      key: 'p018-freeze',
      body: 'the P-018 freeze conclusion',
      source_ref: 'wi:EI-22063684320590166',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatIssues(parsed.error.issues);
      expect(msg).toContain('source_ref');
      // The regression both reports named: unrelated required fields from a
      // federation branch the caller never asked for.
      expect(msg).not.toContain('harness');
      expect(msg).not.toContain('shareable');
      expect(msg).not.toContain('settledBy');
    }
  });

  it('names only the unrecognized legacy ttlDays on an owner-fact correction', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'owner',
      key: 'launch-provenance',
      body: 'a settled conclusion',
      ttlDays: 7,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatIssues(parsed.error.issues);
      expect(msg).toContain('ttlDays');
      expect(msg).not.toContain('shareable');
      expect(msg).not.toContain('kind');
    }
  });

  it('accepts the canonical spellings the reports were reaching for', () => {
    // Calibration: proves each rejection above is about the KEY NAME and not
    // about some other defect in the surrounding fact.
    expect(
      assertTool.args.safeParse({
        scope: 'workspace',
        key: 'p018-freeze',
        body: 'the P-018 freeze conclusion',
        ttlSec: 60,
        sourceRef: 'wi:EI-22063684320590166',
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        key: 'launch-provenance',
        body: 'a settled conclusion',
        ttlSec: 604800,
      }).success,
    ).toBe(true);
  });
});

/**
 * WI-10005668 — `value` is accepted as an ALIAS of `body`. Measured 2026-10-02: 32
 * `facts:assert` refusals / 14 distinct owners in 24h named the unrecognized key
 * `value`; every one was a caller who meant `body`. `claim` (8 / 5 owners) is
 * deliberately NOT aliased.
 *
 * These assertions go through `safeParse` and read the PARSED data: the args schema is a
 * `z.preprocess` pipe, so `.shape` is undefined and a shape-based assertion would pass
 * vacuously. Each case below also has a control that must still be refused, so the alias
 * cannot silently widen into "accept any stray key".
 */
describe('facts:assert accepts `value` as an alias of `body` (WI-10005668)', () => {
  const { body: _body, ...withoutBody } = base;

  it('folds a string `value` into `body` when body is absent', () => {
    const parsed = assertTool.args.safeParse({ ...withoutBody, value: 'the aliased conclusion' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.body).toBe('the aliased conclusion');
      expect('value' in parsed.data).toBe(false);
    }
  });

  it('still refuses `value` when `body` is also present — no silent choice between the two', () => {
    const parsed = assertTool.args.safeParse({ ...base, value: 'a second, competing body' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(formatIssues(parsed.error.issues)).toContain('value');
  });

  it('still refuses a non-string `value` instead of coercing it into a body', () => {
    for (const value of [42, true, { text: 'nested' }, ['a'], null]) {
      const parsed = assertTool.args.safeParse({ ...withoutBody, value });
      expect(parsed.success, JSON.stringify(value)).toBe(false);
    }
  });

  it('does not alias `claim` (the other candidate the refusal ledger surfaced)', () => {
    const parsed = assertTool.args.safeParse({ ...withoutBody, claim: 'a claim, not a body' });
    expect(parsed.success).toBe(false);
  });

  it('keeps the downstream body checks running on the aliased value', () => {
    // An empty alias must reach the SAME `body` minimum the canonical spelling hits, proving
    // the preprocess hands off to the strict schema rather than short-circuiting around it.
    const aliased = assertTool.args.safeParse({ ...withoutBody, value: '' });
    const canonical = assertTool.args.safeParse({ ...base, body: '' });
    expect(canonical.success).toBe(false);
    expect(aliased.success).toBe(false);
  });

  it('leaves the published JSON Schema on the canonical field (alias not advertised)', () => {
    const json = z.toJSONSchema(assertTool.args as never) as {
      properties?: Record<string, unknown>;
    };
    expect(json.properties).toHaveProperty('body');
    expect(json.properties).not.toHaveProperty('value');
  });
});
