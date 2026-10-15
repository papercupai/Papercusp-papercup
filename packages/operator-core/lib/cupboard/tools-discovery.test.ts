/**
 * Tools-discovery projection tests (tool-distribution-granularity P-006).
 *
 * Built over the PURE assembler (`assemblePackCatalog`) so the test doubles as
 * a contract check between pack-catalog's derived view and the discovery
 * payload the marketplace Tools section renders:
 *
 *   - every known tool appears exactly once, resolved through the ladder
 *     (installed unit ▸ builtin ▸ cupboard listing);
 *   - an installed unit shadows the Cupboard listing claiming the same tool;
 *   - installable entries carry the providing listing (id + kind) so the UI
 *     can offer the install action;
 *   - q/status filters narrow without breaking counts.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { addresseeArg } from '../agent-tools/_addressee-arg';
import { assemblePackCatalog, type PackCatalogInputs } from './pack-catalog';
import {
  buildToolsDiscovery,
  buildToolProvenance,
  resolveToolEntries,
  schemaToText,
  UNION_CONDITIONAL_HINT_MAX_CHARS,
  type ToolMetaIndex,
  unionConditionalHint,
} from './tools-discovery';

function makeInputs(over: Partial<PackCatalogInputs> = {}): PackCatalogInputs {
  return {
    installed: [
      {
        name: '@papercupai/repomix',
        version: '1.2.0',
        description: 'Repo packer',
        kind: 'plugin',
        tools: [{ name: 'pack' }],
      },
    ],
    projectedTools: [
      { pluginName: 'agent-mcp', mcpName: 'coord:send' },
      { pluginName: '@papercupai/repomix', mcpName: 'repomix.pack' },
    ],
    legacyCatalogNames: ['plans:get'],
    cupboardUnits: [
      {
        name: 'markdown-tools',
        kind: 'pack',
        listingId: 'lst-1',
        providesTools: ['md.render', 'md.lint'],
        description: 'Markdown helpers',
      },
      {
        name: 'slack-notify',
        kind: 'plugin',
        listingId: 'lst-2',
        providesTools: ['slack.send'],
      },
    ],
    cupboardReachable: true,
    ...over,
  };
}

describe('buildToolsDiscovery', () => {
  it('lists every known tool once, sorted, with resolved providers', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const names = payload.tools.map((t) => t.tool);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(['plans:get', 'coord:send', 'repomix.pack', 'md.render', 'md.lint', 'slack.send']),
    );
    expect(payload.counts).toEqual({ available: 3, installable: 3 });
    expect(payload.cupboardReachable).toBe(true);
  });

  it('builtin tools resolve available with no unit', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const coord = payload.tools.find((t) => t.tool === 'coord:send');
    expect(coord).toMatchObject({ status: 'available', provider: { kind: 'builtin' } });
    expect(coord?.unit).toBeUndefined();
    const plans = payload.tools.find((t) => t.tool === 'plans:get');
    expect(plans?.provider.kind).toBe('builtin');
  });

  it('an installed plugin tool resolves available with its unit descriptor', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const repomix = payload.tools.find((t) => t.tool === 'repomix.pack');
    expect(repomix).toMatchObject({
      status: 'available',
      provider: { kind: 'plugin', name: '@papercupai/repomix' },
      unit: { source: 'installed', kind: 'plugin', version: '1.2.0' },
    });
  });

  it('a Cupboard-only tool resolves installable, carrying the providing listing', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    const md = payload.tools.find((t) => t.tool === 'md.render');
    expect(md).toMatchObject({
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
      unit: { source: 'cupboard', kind: 'pack', listingId: 'lst-1', description: 'Markdown helpers' },
    });
    const slack = payload.tools.find((t) => t.tool === 'slack.send');
    expect(slack?.provider).toMatchObject({ kind: 'plugin', name: 'slack-notify', listingId: 'lst-2' });
  });

  it('an installed unit shadows a Cupboard listing claiming the same tool', () => {
    const inputs = makeInputs({
      cupboardUnits: [
        { name: 'repomix-listing', kind: 'plugin', listingId: 'lst-9', providesTools: ['repomix.pack'] },
      ],
    });
    const payload = buildToolsDiscovery(assemblePackCatalog(inputs));
    const repomix = payload.tools.find((t) => t.tool === 'repomix.pack');
    expect(repomix?.status).toBe('available');
    expect(repomix?.provider.name).toBe('@papercupai/repomix');
  });

  it('q filter matches tool name OR providing unit name, case-insensitively', () => {
    const cat = assemblePackCatalog(makeInputs());
    const byTool = buildToolsDiscovery(cat, { q: 'MD.' });
    expect(byTool.tools.map((t) => t.tool)).toEqual(['md.lint', 'md.render']);
    const byUnit = buildToolsDiscovery(cat, { q: 'slack-notify' });
    expect(byUnit.tools.map((t) => t.tool)).toEqual(['slack.send']);
  });

  it('status filter narrows to one resolution status and counts follow', () => {
    const cat = assemblePackCatalog(makeInputs());
    const installable = buildToolsDiscovery(cat, { status: 'installable' });
    expect(installable.tools.every((t) => t.status === 'installable')).toBe(true);
    expect(installable.counts).toEqual({ available: 0, installable: 3 });
  });

  it('propagates cupboardReachable=false for the degraded banner', () => {
    const cat = assemblePackCatalog(makeInputs({ cupboardUnits: [], cupboardReachable: false }));
    expect(buildToolsDiscovery(cat).cupboardReachable).toBe(false);
  });
});

describe('buildToolsDiscovery — categories (P-007 facets)', () => {
  it('faceted by namespace, busiest first then alphabetical', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()));
    // md.render + md.lint → md(2); the rest one each.
    expect(payload.categories[0]).toEqual({ name: 'md', count: 2 });
    const names = payload.categories.map((c) => c.name);
    expect(names).toEqual(['md', 'coord', 'plans', 'repomix', 'slack']);
  });

  it('a category filter narrows the tools but the facets stay over the full search set', () => {
    const cat = assemblePackCatalog(makeInputs());
    const payload = buildToolsDiscovery(cat, { category: 'md' });
    expect(payload.tools.map((t) => t.tool)).toEqual(['md.lint', 'md.render']);
    expect(payload.counts).toEqual({ available: 0, installable: 2 });
    // facets are computed pre-narrow → still every category, so the UI can switch.
    expect(payload.categories.map((c) => c.name)).toContain('coord');
  });

  it('every entry carries its category', () => {
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()));
    expect(entries.find((e) => e.tool === 'coord:send')?.category).toBe('coord');
    expect(entries.find((e) => e.tool === 'md.render')?.category).toBe('md');
  });
});

describe('buildToolsDiscovery — capability search over descriptions (P-005)', () => {
  const meta: ToolMetaIndex = new Map([
    ['coord:send', { description: 'send a message to a peer', capability: 'coord:write' }],
    ['repomix.pack', { description: 'pack a repo into one document', capability: null }],
  ]);

  it('enriches built-in entries with description + capability from the meta index', () => {
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()), meta);
    const coord = entries.find((e) => e.tool === 'coord:send');
    expect(coord?.description).toBe('send a message to a peer');
    expect(coord?.capability).toBe('coord:write');
  });

  it('carries argSchema text from the meta index onto the entry (null when absent)', () => {
    const m: ToolMetaIndex = new Map([
      ['coord:send', { description: 'd', capability: null, argSchema: 'to:string recipient; body?:string text' }],
    ]);
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()), m);
    expect(entries.find((e) => e.tool === 'coord:send')?.argSchema).toBe('to:string recipient; body?:string text');
    // A tool with no meta argSchema resolves to null, never undefined.
    expect(entries.find((e) => e.tool === 'repomix.pack')?.argSchema).toBeNull();
  });

  it('finds a tool by a capability word only present in its description', () => {
    const payload = buildToolsDiscovery(assemblePackCatalog(makeInputs()), { q: 'message' }, meta);
    expect(payload.tools.map((t) => t.tool)).toEqual(['coord:send']);
  });

  it('a Cupboard-only tool falls back to its unit description when meta is absent', () => {
    const entries = resolveToolEntries(assemblePackCatalog(makeInputs()), meta);
    const md = entries.find((e) => e.tool === 'md.render');
    expect(md?.description).toBe('Markdown helpers'); // from the markdown-tools unit
  });
});

describe('buildToolProvenance — "what provides X" (P-006)', () => {
  it('resolves an exact tool name to its providing unit + install action', () => {
    const payload = buildToolProvenance(assemblePackCatalog(makeInputs()), { tool: 'md.render' });
    expect(payload.resolved?.tool).toBe('md.render');
    expect(payload.resolved).toMatchObject({
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
    });
    expect(payload.matches[0]?.tool).toBe('md.render'); // exact resolution leads
  });

  it('answers a capability phrase with ranked candidate providers', () => {
    const payload = buildToolProvenance(assemblePackCatalog(makeInputs()), { q: 'markdown' });
    expect(payload.resolved).toBeNull();
    expect(payload.matches.map((m) => m.tool)).toEqual(expect.arrayContaining(['md.render', 'md.lint']));
  });

  it('an unknown tool name resolves to null (no fabricated resolution)', () => {
    // a name with no token overlap → null resolved + no capability matches
    const payload = buildToolProvenance(assemblePackCatalog(makeInputs()), { tool: 'zzz.qqq' });
    expect(payload.resolved).toBeNull();
    expect(payload.matches).toEqual([]);
  });
});

describe('schemaToText — compact arg-schema text (tools:find searchable params)', () => {
  it('renders properties as key:type description, marking optionals with ?', () => {
    const txt = schemaToText({
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'the flag key' },
        enabled: { type: 'boolean', description: 'on or off' },
      },
    });
    expect(txt).toBe('key:string the flag key; enabled?:boolean on or off');
  });

  it('renders an enum property\'s actual member values (no type set) and tolerates a missing description', () => {
    expect(schemaToText({ properties: { mode: { enum: ['a', 'b'] } } })).toBe('mode?:enum(a|b)');
  });

  it('EI-13164: an enum property still renders its member values when the JSON schema ALSO carries type:"string" — the real zod z.enum() shape, previously dead-coded to a bare :string', () => {
    // zod's own toJSONSchema for `z.enum(['critical','major','minor','nit'])` emits
    // BOTH `type:"string"` and `enum:[...]` — the exact shape that used to lose the
    // enum entirely (the `type` branch matched first), so tools:find described
    // `improvements:capture`'s `severity` arg as a bare `:string` and a plausible
    // value ("low") was accepted by discovery but rejected at call time.
    const txt = schemaToText({
      properties: {
        severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'], description: 'how bad' },
      },
    });
    expect(txt).toBe('severity?:enum(critical|major|minor|nit) how bad');
  });

  it('EI-211537: preserves a JSON-schema const emitted by z.literal so tools:find shows the accepted value', () => {
    const txt = schemaToText({
      properties: {
        kind: { type: 'string', const: 'green-checkpoint' },
      },
    });
    expect(txt).toBe('kind?:enum(green-checkpoint)');
  });

  it('returns null for a no-arg / absent / non-object schema', () => {
    expect(schemaToText({ type: 'object', properties: {} })).toBeNull();
    expect(schemaToText({ type: 'object' })).toBeNull();
    expect(schemaToText(null)).toBeNull();
    expect(schemaToText('nope')).toBeNull();
  });

  it('preserves a release:trace-style path-or-sha union in discovery text', () => {
    const txt = schemaToText({
      anyOf: [
        {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' }, sha: { type: 'string' } },
        },
        {
          type: 'object',
          required: ['sha'],
          properties: { path: { type: 'string' }, sha: { type: 'string' } },
        },
      ],
    });
    expect(txt).toContain('one-of:path|sha');
    expect(txt).toContain('path?:string');
    expect(txt).toContain('sha?:string');
  });

  it('merges every discriminated-union literal and deduplicates repeated required-key hints', () => {
    const txt = schemaToText({
      oneOf: [
        { type: 'object', required: ['op'], properties: { op: { const: 'get' }, stallReds: { type: 'integer' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'set' }, enabled: { type: 'boolean' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'hold' }, reason: { type: 'string' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'unhold' } } },
      ],
    });

    expect(txt).toContain('one-of:op;');
    expect(txt).not.toContain('one-of:op|op');
    expect(txt).toContain('op:enum(get|set|hold|unhold)');
    expect(txt).toContain('stallReds?:integer');
    expect(txt).toContain('enabled?:boolean');
    expect(txt).toContain('reason?:string');
  });

  it('retains nested discriminated-union prohibitions in discovery text', () => {
    const schema = z.toJSONSchema(z.object({ addressee: addresseeArg }).strict());
    const text = schemaToText(schema);

    expect(text).toContain('constraint:addressee (');
    expect(text).toContain('when from=contact => contactExternalId required');
    expect(text).toContain('when from!=contact => contactExternalId forbidden');
    expect(text).toContain('when from=thread-participant => source,externalId required');
    expect(text).toContain('when from!=thread-participant => source,externalId forbidden');
  });

  it('preserves explicit discriminator-dependent required and forbidden fields', () => {
    const branches = [
      {
        required: ['kind', 'settledBy'],
        properties: {
          kind: { const: 'undecidable' },
          settledBy: { type: 'string' },
        },
      },
      {
        required: ['kind'],
        properties: {
          kind: { enum: ['conclusion', 'assumption', 'convention'] },
          settledBy: { not: {} },
        },
      },
    ];

    expect(unionConditionalHint(branches)).toBe(
      'when kind=undecidable => settledBy required; when kind!=undecidable => settledBy forbidden',
    );
    expect(schemaToText({ anyOf: branches })).toContain(
      'when kind=undecidable => settledBy required; when kind!=undecidable => settledBy forbidden',
    );
  });

  it('groups matching branch requirements before the compact union-hint cap', () => {
    const branches = [
      {
        additionalProperties: false,
        required: ['kind', 'workItem'],
        properties: { kind: { const: 'work-item' }, workItem: { type: 'string' } },
      },
      {
        additionalProperties: false,
        required: ['kind', 'fleet'],
        properties: { kind: { const: 'fleet-leader' }, fleet: { type: 'string' } },
      },
      {
        additionalProperties: false,
        required: ['kind', 'turnRef', 'quote'],
        properties: {
          kind: { const: 'owner-turn' },
          turnRef: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    ];

    const hint = unionConditionalHint(branches);
    expect(hint).toContain('when kind=owner-turn => turnRef,quote required');
    expect(hint).toContain('when kind!=owner-turn => turnRef,quote forbidden');
    expect(hint.length).toBeLessThanOrEqual(UNION_CONDITIONAL_HINT_MAX_CHARS);
  });

  it('treats omitted fields as forbidden only for closed union branches', () => {
    const closedBranches = [
      {
        additionalProperties: false,
        required: ['op', 'expectedCandidate'],
        properties: {
          op: { const: 'retire' },
          expectedCandidate: { type: 'string' },
        },
      },
      {
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { const: 'get' },
        },
      },
    ];

    expect(unionConditionalHint(closedBranches)).toBe(
      'when op=retire => expectedCandidate required; when op!=retire => expectedCandidate forbidden',
    );

    const openBranches = closedBranches.map(({ additionalProperties: _closed, ...branch }) => branch);
    expect(unionConditionalHint(openBranches)).toBe('');
  });

  it('preserves a closed-branch prohibition when sibling branches keep the field optional', () => {
    const branches = [
      {
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { const: 'claim' },
          harness: { type: 'string' },
        },
      },
      {
        additionalProperties: false,
        required: ['mode'],
        properties: { mode: { const: 'resubmit' } },
      },
    ];

    expect(unionConditionalHint(branches)).toBe('when mode=resubmit => harness forbidden');
    expect(schemaToText({ oneOf: branches })).toContain('when mode=resubmit => harness forbidden');
  });

  it('retains every conditional rule beyond the former four-relation cap', () => {
    const operations = ['op-1', 'op-2', 'op-3', 'op-4', 'op-5', 'op-6'];
    const branches = operations.map((operation, selectedIndex) => {
      const properties: Record<string, unknown> = { op: { const: operation } };
      const required = ['op'];
      operations.forEach((_value, index) => {
        const field = 'field' + (index + 1);
        if (index === selectedIndex) {
          properties[field] = { type: 'string' };
          required.push(field);
        } else {
          properties[field] = { not: {} };
        }
      });
      return { additionalProperties: false, required, properties };
    });

    const hint = unionConditionalHint(branches);
    for (let index = 0; index < operations.length; index += 1) {
      const selected = operations[index]!;
      expect(hint).toContain(
        'when op=' + selected + ' => field' + (index + 1) + ' required; when op!=' + selected +
          ' => field' + (index + 1) + ' forbidden',
      );
    }
    expect(hint).not.toContain('conditional branch rules omitted');
    expect(hint.length).toBeLessThanOrEqual(UNION_CONDITIONAL_HINT_MAX_CHARS);
  });

  it('signals when conditional rules cannot fit instead of returning a partial contract', () => {
    const longField = 'field'.repeat(300);
    const hint = unionConditionalHint([
      {
        additionalProperties: false,
        required: ['op', longField],
        properties: { op: { const: 'write' }, [longField]: { type: 'string' } },
      },
      {
        additionalProperties: false,
        required: ['op'],
        properties: { op: { const: 'read' }, [longField]: { not: {} } },
      },
    ]);

    expect(hint).toBe('conditional branch rules omitted; request full schema');
  });

  it('signals when a discriminator has too many values for a complete conditional rule', () => {
    const operations = Array.from({ length: 10 }, (_value, index) => 'op-' + index);
    const branches = operations.map((operation, index) => ({
      additionalProperties: false,
      required: ['op'],
      properties: {
        op: { const: operation },
        target: index === 0 ? { type: 'string' } : { not: {} },
      },
    }));

    expect(unionConditionalHint(branches)).toBe('conditional branch rules omitted; request full schema');
  });

  describe('EI-13181: numeric/length bounds (same lossy-discovery class as EI-13164 — a min/max is dropped just like an enum was)', () => {
    it('a min+max integer (sessions:digest\'s real z.number().int().min(1).max(100)) renders the inclusive range', () => {
      // zod's toJSONSchema for `z.number().int().min(1).max(100).optional().describe('Default 30.')`
      // emits `{ type:"integer", minimum:1, maximum:100, description:"Default 30." }` — the exact
      // shape that used to render as a bare `limit?:integer` with the ceiling invisible until a
      // call with limit:200 was rejected at runtime.
      const txt = schemaToText({
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 30.' } },
      });
      expect(txt).toBe('limit?:integer(1-100) Default 30.');
    });

    it('a max-only bound renders as ≤N', () => {
      expect(schemaToText({ properties: { limit: { type: 'integer', maximum: 100 } } })).toBe('limit?:integer(≤100)');
    });

    it('a min-only bound renders as ≥N', () => {
      expect(schemaToText({ properties: { count: { type: 'number', minimum: 1 } } })).toBe('count?:number(≥1)');
    });

    it('preserves an exclusive lower bound instead of teaching the rejected boundary', () => {
      expect(
        schemaToText({ properties: { timeout_sec: { type: 'integer', exclusiveMinimum: 0, maximum: 604800 } } }),
      ).toBe('timeout_sec?:integer(>0-604800)');
    });

    it('supports draft-04 boolean exclusivity alongside an inclusive bound', () => {
      expect(
        schemaToText({ properties: { value: { type: 'number', minimum: 0, exclusiveMinimum: true } } }),
      ).toBe('value?:number(>0)');
    });

    it('a string maxLength renders the same way (e.g. hardText caps)', () => {
      expect(schemaToText({ properties: { title: { type: 'string', maxLength: 400 } } })).toBe('title?:string(≤400)');
    });

    it('an array maxItems renders the same way (e.g. a `paths` cap)', () => {
      expect(schemaToText({ properties: { paths: { type: 'array', maxItems: 20 } } })).toBe('paths?:array(≤20)');
    });

    it('EI-20250807342723221: an array item enum is visible in discovery text', () => {
      // zod-to-json-schema places z.array(z.enum([...]))'s enum under `items`,
      // not beside the property type. The allowed values must survive the
      // compact projection or tools:find teaches callers an invalid shape.
      const txt = schemaToText({
        properties: {
          states: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', enum: ['open', 'failing'] },
            description: 'claimable states',
          },
        },
      });
      expect(txt).toBe('states?:array(≤20)<enum(open|failing)> claimable states');
    });

    it('EI-21579794371308546: a primitive array item type is visible in discovery text', () => {
      // coord:send's `premises` is an array of ref strings, while neighbouring
      // section fields are arrays/objects with their own structured members.
      // Omitting the item type makes the compact schema teach an ambiguous
      // `array(≤20)` shape and invites object-shaped premises.
      const txt = schemaToText({
        properties: {
          premises: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', minLength: 1 },
          },
          forYouBecause: {
            type: 'object',
            properties: { relation: { type: 'string' } },
            required: ['relation'],
          },
        },
      });
      expect(txt).toBe('premises?:array(≤20)<string>; forYouBecause?:object{relation}');
    });

    it('no bound declared → no parens (unchanged from before)', () => {
      expect(schemaToText({ properties: { key: { type: 'string' } } })).toBe('key?:string');
    });

    it('an enum never gets a bound suffix even if minimum/maximum were also present (zod never emits both, but stay defensive)', () => {
      const txt = schemaToText({
        properties: { mode: { type: 'string', enum: ['a', 'b'], minimum: 1, maximum: 2 } },
      });
      expect(txt).toBe('mode?:enum(a|b)');
    });
  });

  describe('EI-13183: `.regex()` pattern constraints (same lossy-discovery class as EI-13181/13164 — a pattern is dropped just like a bound was)', () => {
    it("locks:release's real z.string().regex(/^[0-9a-f]{40,64}$/) renders the pattern inline", () => {
      // zod's toJSONSchema for `z.string().regex(/^[0-9a-f]{40,64}$/).optional()` emits
      // `{ type:"string", pattern:"^[0-9a-f]{40,64}$" }` (verified live) — the exact shape
      // that used to render as a bare `published_sha?:string`, hiding the 40-64 hex-char
      // requirement until a call with an abbreviated SHA was rejected at runtime.
      const txt = schemaToText({
        properties: { published_sha: { type: 'string', pattern: '^[0-9a-f]{40,64}$' } },
      });
      expect(txt).toBe('published_sha?:string~/^[0-9a-f]{40,64}$/');
    });

    it('no pattern declared → no suffix (unchanged from before)', () => {
      expect(schemaToText({ properties: { key: { type: 'string' } } })).toBe('key?:string');
    });

    it('a bound AND a pattern can compose (both suffixes render, bound first)', () => {
      const txt = schemaToText({
        properties: { code: { type: 'string', maxLength: 10, pattern: '^[A-Z]+$' } },
      });
      expect(txt).toBe('code?:string(≤10)~/^[A-Z]+$/');
    });

    it('an enum never gets a pattern suffix even if pattern were also present (zod never emits both, but stay defensive)', () => {
      const txt = schemaToText({
        properties: { mode: { type: 'string', enum: ['a', 'b'], pattern: '^[ab]$' } },
      });
      expect(txt).toBe('mode?:enum(a|b)');
    });

    it('renders an array item pattern (plans:add-decision refs)', () => {
      const txt = schemaToText({
        properties: {
          refs: {
            type: 'array',
            items: { type: 'string', pattern: '^P-\\d{3,}$' },
            description: 'in-plan item refs only',
          },
        },
      });
      expect(txt).toBe('refs?:array<string~/^P-\\d{3,}$/> in-plan item refs only');
    });
  });

  it('EI-13190: names a nested object property\'s own fields, marking its required ones', () => {
    // Mirrors locks:acquire's `wait: z.object({ max_sec }).optional()` — the
    // exact shape that used to render as bare `wait?:object`, hiding that
    // `max_sec` (not e.g. `timeout_ms`) is the field to pass.
    const txt = schemaToText({
      type: 'object',
      properties: {
        wait: {
          type: 'object',
          properties: { max_sec: { type: 'number', description: 'seconds to block' } },
          required: ['max_sec'],
        },
      },
    });
    expect(txt).toBe('wait?:object{max_sec}');
  });

  it('marks a nested optional field with ? and renders multiple nested fields in order', () => {
    const txt = schemaToText({
      type: 'object',
      required: ['pending_edit'],
      properties: {
        pending_edit: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['file', 'old_string'],
        },
      },
    });
    expect(txt).toBe('pending_edit:object{file,old_string,new_string?}');
  });

  it('renders typed entry fields for a record-valued object instead of a bare object', () => {
    const txt = schemaToText({
      type: 'object',
      properties: {
        instrumentSnapshots: {
          type: 'object',
          propertyNames: { type: 'string', minLength: 1 },
          additionalProperties: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
              measuredAt: { type: 'string', minLength: 1 },
              window: { type: 'object' },
              value: {},
              evidenceRef: { type: 'string', maxLength: 500 },
            },
            required: ['verdict', 'measuredAt'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(txt).toBe('instrumentSnapshots?:object{*:object{verdict,measuredAt,window?,value?,evidenceRef?}}');
  });

  it('renders a bare object type with no nested braces when it has no properties', () => {
    expect(schemaToText({ properties: { anything: { type: 'object' } } })).toBe('anything?:object');
  });
});
