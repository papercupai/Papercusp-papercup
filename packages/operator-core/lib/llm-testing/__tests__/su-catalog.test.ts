/**
 * Tests for the curated `papercusp-su` tool catalog used by the in-process `su`
 * target — the name sanitizer, the Anthropic-shape builder, and the
 * load-bearing playbook invariants the SU behavioral scenarios assert against.
 * Run with: cd packages/operator-core && npx vitest run lib/llm-testing/__tests__/su-catalog.test.ts
 */
import { describe, expect, it } from 'vitest';
import { sanitizeToolName, buildCatalog, SU_CATALOG, type SuCatalogEntry } from '../targets/su-catalog';
import { CODE_SEARCH_CATALOG } from '../targets/code-search-catalog';
import { WORKER_CATALOG } from '../targets/worker';
import { FOR_YOU_BECAUSE_RELATIONS, messageBodyArg } from '../../agent-tools/coordination/message-fields';
import { CompletionRecordSchema } from '../../coord-lifecycle/records';

const ANTHROPIC_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

describe('sanitizeToolName', () => {
  it('replaces every colon with a double underscore', () => {
    expect(sanitizeToolName('docs:get')).toBe('docs__get');
    expect(sanitizeToolName('a:b:c')).toBe('a__b__c');
  });

  it('leaves hyphens and underscores untouched', () => {
    expect(sanitizeToolName('design-phase:list_tokens')).toBe('design-phase__list_tokens');
  });

  it('passes through a name with no colon', () => {
    expect(sanitizeToolName('repomix_pack')).toBe('repomix_pack');
  });

  it('maps a dotted plugin name too — the API refuses a dot exactly like a colon', () => {
    expect(sanitizeToolName('gitnexus.context')).toBe('gitnexus__context');
    expect(sanitizeToolName('gitnexus.context')).toMatch(ANTHROPIC_NAME_RE);
  });
});

describe('every catalog a target ships builds to API-legal, collision-free names', () => {
  const catalogs: Record<string, ReadonlyArray<SuCatalogEntry>> = {
    su: SU_CATALOG,
    worker: WORKER_CATALOG,
    'su-code': [...SU_CATALOG, ...CODE_SEARCH_CATALOG],
  };
  for (const [label, entries] of Object.entries(catalogs)) {
    it(`${label}: every wire name matches the Anthropic constraint and maps back to its canonical name`, () => {
      const built = buildCatalog(entries);
      expect(built.tools).toHaveLength(entries.length);
      for (const t of built.tools) {
        expect(t.name).toMatch(ANTHROPIC_NAME_RE);
        expect(built.canonicalBySanitized.get(t.name)).toBeDefined();
      }
    });
  }

  it('refuses two canonical names that sanitize to the same wire name', () => {
    const entry = (name: string): SuCatalogEntry => ({ name, description: name, input: { type: 'object' } }) as SuCatalogEntry;
    expect(() => buildCatalog([entry('a:b'), entry('a.b')])).toThrow(/both sanitize to "a__b"/);
  });
});

describe('buildCatalog', () => {
  it('defaults to SU_CATALOG and produces one tool per entry', () => {
    const built = buildCatalog();
    expect(built.tools).toHaveLength(SU_CATALOG.length);
  });

  it('sanitizes every tool name to the Anthropic constraint', () => {
    for (const t of buildCatalog().tools) {
      expect(t.name).toMatch(ANTHROPIC_NAME_RE);
      expect(t.name).not.toContain(':');
    }
  });

  it('round-trips sanitized → canonical via canonicalBySanitized', () => {
    const built = buildCatalog();
    for (const t of built.tools) {
      const canonical = built.canonicalBySanitized.get(t.name);
      expect(canonical).toBeDefined();
      expect(sanitizeToolName(canonical!)).toBe(t.name);
    }
  });

  it('forces input_schema.type === "object" on every tool', () => {
    for (const t of buildCatalog().tools) {
      expect(t.input_schema.type).toBe('object');
    }
  });

  it('falls back to a bare object schema for a non-object input', () => {
    const built = buildCatalog([
      { name: 'x:y', description: 'd', input: { type: 'string' } as Record<string, unknown> },
    ]);
    expect(built.tools[0].input_schema).toEqual({ type: 'object' });
  });

  it('honors a custom catalog argument', () => {
    const built = buildCatalog([{ name: 'only:one', description: 'd', input: { type: 'object' } }]);
    expect(built.tools).toHaveLength(1);
    expect(built.canonicalBySanitized.get('only__one')).toBe('only:one');
  });
});

describe('SU_CATALOG load-bearing invariants (what the scenarios assert)', () => {
  const names = SU_CATALOG.map((e) => e.name);

  it('every entry uses the canonical colon form', () => {
    for (const n of names) expect(n).toContain(':');
  });

  it('has no duplicate names', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes NO feature-update / raw-SQL write tool (SU-S05)', () => {
    expect(names).not.toContain('features:update');
    expect(names.some((n) => /features:(update|set)|sql|raw/i.test(n))).toBe(false);
  });

  it('docs:* and plans:* readers carry the harness scope arg', () => {
    for (const e of SU_CATALOG.filter((e) => e.name.startsWith('docs:') || e.name.startsWith('plans:'))) {
      const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).toHaveProperty('harness');
    }
  });

  it('makes docs:get scope and execution-route discovery explicit', () => {
    const docsGet = SU_CATALOG.find((entry) => entry.name === 'docs:get')!;
    const required = (docsGet.input as { required?: string[] }).required ?? [];
    expect(required).toContain('harness');

    const find = SU_CATALOG.find((entry) => entry.name === 'tools:find')!;
    expect(find.description).toMatch(/before offering an execution route/i);
    expect(find.description).toMatch(/unavailable/i);
    expect(find.description).toContain('tools:invoke');

    const invoke = SU_CATALOG.find((entry) => entry.name === 'tools:invoke')!;
    const invokeInput = invoke.input as { properties?: Record<string, unknown>; required?: string[] };
    expect(invokeInput.properties).toMatchObject({
      name: { type: 'string' },
      args: { type: 'object', additionalProperties: true },
    });
    expect(invokeInput.required).toEqual(['name']);
    expect(names).toContain('agent_tools:list');
  });

  it('plans:list advertises the real full-lifecycle switch instead of a synthetic status:all', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'plans:list')!;
    const properties = (entry.input as { properties?: Record<string, any> }).properties ?? {};

    expect(properties.includeArchived).toMatchObject({ type: 'boolean' });
    expect(properties.status.enum).not.toContain('all');
    expect(entry.description).toMatch(/includeArchived:true/);
  });

  it('plans:set-status uses the live scalar item argument', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'plans:set-status')!;
    const input = entry.input as { properties?: Record<string, unknown>; required?: string[] };

    expect(input.properties).toHaveProperty('item');
    expect(input.properties).not.toHaveProperty('itemId');
    expect(input.required).toEqual(['slug', 'item', 'status']);
  });

  it('work_items:complete advertises structured evidence rather than the obsolete flat summary', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'work_items:complete')!;
    const input = entry.input as { properties: Record<string, any>; required: string[] };
    expect(input.required).toEqual(['id', 'completion']);
    expect(input.properties).not.toHaveProperty('summary');
    expect(input.properties.completion.required).toContain('summary');
    expect(input.properties.completion.properties.verification.properties).toHaveProperty('testsRun');
    expect(input.properties).toHaveProperty('state');
    expect(input.properties).toHaveProperty('assumptions');
    expect(entry.description).toMatch(/record.only|record only/i);
    expect(entry.description).toMatch(/independent/i);
    // Anchor the documented completion record to its canonical schema without
    // importing the live tool registry or executing its mutating handler.
    expect(CompletionRecordSchema.safeParse({
      workItem: 'WI-93301', summary: 'Held verification task tested; independent acceptance remains pending.',
      verification: { testsRun: 'fixture/current-task.test.ts', testResult: 'pass', verifiedHow: 'unit', filesChanged: [] },
    }).success).toBe(true);
  });

  it('exposes the PG-canonical docs:author write required by SU-S12', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'docs:author')!;
    const input = entry.input as { properties?: Record<string, unknown>; required?: string[] };
    expect(input.properties).toMatchObject({
      slug: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      harness: { type: 'string' },
    });
    expect(input.required).toEqual(['slug', 'title', 'body']);
    expect(entry.description).toMatch(/PG-canonical/i);
  });

  it('coord:send teaches the current structured-body and directed-request contract', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'coord:send')!;
    const input = entry.input as { required: string[]; properties: Record<string, any> };
    expect(input.required).toEqual(['to', 'summary', 'expects']);
    expect(input.properties.expects.enum).toEqual(['ack', 'answer', 'action', 'none']);
    const body = input.properties.body;
    expect(body).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
    expect(body.items.required).toContain('text');
    expect(body.items.additionalProperties).toBe(false);
    expect(body.items.properties.forYouBecause.properties.relation.enum).toEqual([...FOR_YOU_BECAUSE_RELATIONS]);
    expect(body.items.properties).not.toHaveProperty('expects');
    expect(input.properties).not.toHaveProperty('basedOn');
    expect(entry.description).toContain('forYouBecause');
    expect(entry.description).toContain('600 characters');
    // Canonical pure schema, not a permissive mock: do not boot the live dispatcher.
    expect(messageBodyArg.safeParse('Please review.').success).toBe(false);
    expect(messageBodyArg.safeParse([{ text: 'Please review.', forYouBecause: { relation: 'other', note: 'Independent reviewer.' } }]).success).toBe(true);
    expect(messageBodyArg.safeParse([{ text: 'Please review.', expects: 'action' }]).success).toBe(false);
  });

  it('advertises improvements:capture ideation.cheapExperiment as a structured ScoutExperiment', () => {
    const entry = SU_CATALOG.find((e) => e.name === 'improvements:capture')!;
    const properties = (entry.input as { properties?: Record<string, any> }).properties ?? {};
    const ideation = properties.ideation as { properties?: Record<string, any> };
    const cheapExperiment = ideation.properties?.cheapExperiment;

    expect(cheapExperiment).toMatchObject({
      type: 'object',
      required: ['hypothesis', 'method', 'falsifiableSignal'],
    });
    expect(cheapExperiment.properties).toEqual({
      hypothesis: expect.objectContaining({ type: 'string' }),
      method: expect.objectContaining({ type: 'string' }),
      falsifiableSignal: expect.objectContaining({ type: 'string' }),
    });
  });

  it('advertises improvements:capture body and nested toolFailure.directEvidence contracts', () => {
    const entry = SU_CATALOG.find((e) => e.name === 'improvements:capture')!;
    const properties = (entry.input as { properties?: Record<string, any> }).properties ?? {};
    const toolFailure = properties.toolFailure as { properties?: Record<string, any> };

    expect(properties).toHaveProperty('body');
    expect(properties).not.toHaveProperty('summary');
    expect(toolFailure).toMatchObject({ type: 'object' });
    const directEvidence = toolFailure?.properties?.directEvidence;
    expect(directEvidence).toMatchObject({
      type: 'object',
      required: ['kind', 'expected', 'actual'],
      properties: {
        kind: { type: 'string', enum: ['valid-input-reproduction', 'server-contract-mismatch', 'hard-internal'] },
        expected: { type: 'string' },
        actual: { type: 'string' },
      },
    });
  });

  it('keeps the curated code:run fixture aligned with its JavaScript-only runtime contract', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'code:run')!;
    const properties = (entry.input as { properties?: Record<string, any> }).properties ?? {};
    const script = properties.script as { description?: string };

    expect(script.description).toContain('Plain JavaScript body only');
    expect(script.description).toContain('TypeScript annotations such as `: any` are not supported');
    expect(script.description).not.toContain('JS/TS body');
  });

  it('work_items:set_state is advertised with keyed lifecycle args', () => {
    const e = SU_CATALOG.find((e) => e.name === 'work_items:set_state')!;
    const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('ids');
    expect(props).toHaveProperty('items');
    expect(props).toHaveProperty('state');
    expect(props).toHaveProperty('completionRef');
    expect(props).toHaveProperty('assumptions');
    expect(props).not.toHaveProperty('row');
    expect((props.ids as { maxItems?: number }).maxItems).toBe(200);
    expect(e.input).not.toHaveProperty('anyOf');
  });

  it('work_items:get advertises the real scalar-or-bulk id contract', () => {
    const e = SU_CATALOG.find((entry) => entry.name === 'work_items:get')!;
    const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('ids');
    expect((props.ids as { minItems?: number; maxItems?: number })).toMatchObject({
      minItems: 1,
      maxItems: 100,
    });
    expect(e.input).not.toHaveProperty('anyOf');
  });

  it('exposes the direct work_items:claim wire contract required by SU-S27', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'work_items:claim')!;
    const input = entry.input as { properties?: Record<string, unknown>; required?: string[] };

    expect(input.properties).toMatchObject({ row: { type: 'string' } });
    expect(input.required).toEqual(['row']);
    expect(entry.description).toMatch(/id,assignee\?,harness\?,force\?,reason\?/);
    expect(entry.description).toMatch(/direct(ed)? claim/i);
  });

  it('locks:acquire exposes the queued wake path required by SU-S11', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'locks:acquire')!;
    const properties = (entry.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties.wake_on_grant).toMatchObject({ type: 'boolean' });
    expect(entry.description).toMatch(/wake_on_grant:true/);
    expect(entry.description).toMatch(/end your turn/i);
  });

  it('keeps every Anthropic tool input schema free of unsupported top-level combinators', () => {
    for (const entry of SU_CATALOG) {
      expect(entry.input, entry.name).not.toHaveProperty('oneOf');
      expect(entry.input, entry.name).not.toHaveProperty('anyOf');
      expect(entry.input, entry.name).not.toHaveProperty('allOf');
    }
  });

  it('audit:list documents its self-describing TOON read contract (EI-136)', () => {
    const e = SU_CATALOG.find((e) => e.name === 'audit:list')!;
    // The catalog the SUT reads must describe the encoding it will actually be
    // handed, or SU-S08 measures the model against a contract that isn't shipped.
    expect(e.description).toMatch(/toon/i);
    expect(e.description).toMatch(/id,ts,actor,action,subject/);
    // It must NOT still advertise the headerless form that EI-136 retired.
    expect(e.description).not.toMatch(/headerless/i);
  });

  it('reserves harness:overview for a compound picture and routes one status fact directly (SU-S19/S20)', () => {
    const e = SU_CATALOG.find((entry) => entry.name === 'harness:overview')!;
    expect(e.description).toContain("COMPOUND 'state of X'");
    expect(e.description).toContain('multi-part/full-picture');
    expect(e.description).toContain('single fact such as active/current phase');
    expect(e.description).toContain('direct harness:status call');
  });

  it('exposes the existing read and activation tools required by the S26/S31 hermetic worlds', () => {
    for (const name of [
      'capability:read',
      'logs:read',
      'dev:pg_query',
      'dev:pipeline_position',
      'git-sync:run',
      'dev:restart',
    ]) {
      expect(names, `${name} should be offered to the SU SUT`).toContain(name);
    }

    expect(SU_CATALOG.find((entry) => entry.name === 'dev:pg_query')!.description).toMatch(/read-only/i);
    expect(names).not.toContain('dev:pg_mutate');
  });

  it('includes the design-phase group the playbook mandates for UI work', () => {
    expect(names.some((n) => n.startsWith('design-phase:'))).toBe(true);
  });
});
