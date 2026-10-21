/**
 * send-arg-shape.test.ts — WI-6522: coord:send's REFUSAL TEXT, pinned.
 *
 * This file tests the arg SCHEMA (`sendTool.args.safeParse`), not the handler —
 * send.test.ts covers the handler with the engine mocked. Nothing here does IO.
 *
 * WHY THIS EXISTS. Measured over 14 days (harness_shared.tool_invocations,
 * tool_name='coord:send'): 5,086 ok vs 578 non-ok, and 530 of those 578 (92%)
 * were TWO refusal messages that did not tell the caller what to fix:
 *
 *   334 refusals / 135 distinct senders — one generic bulk-vs-single menu emitted
 *       for every distinct single-send mistake (missing `to`, missing `summary`,
 *       empty `summary`), masking the specific per-field errors that toArg and
 *       summaryArg ALREADY carried.
 *   196 refusals /  80 distinct senders — a bare zod "Invalid input" from `wake`'s
 *       union, naming neither the booleans nor 'required'/'optimistic'.
 *
 * A rejected send is a DROPPED MESSAGE — the caller is an agent mid-turn and most
 * do not retry a validation error — so this is silent coordination loss, not a
 * logged nuisance. The fix changes NO accepted shape: every call that parsed
 * before still parses (the non-regression block at the bottom pins that). Only the
 * text a REFUSAL carries changed.
 *
 * ⚠ THE LOAD-BEARING PIN IS `preserves EI-7838 precedence`. The {to,summary} check
 * lives in a z.preprocess, NOT a trailing .refine(), because zod short-circuits a
 * refine when a sibling field also fails — the older defect where a missing
 * `summary` went unreported and the caller was misdirected to "wake: Invalid
 * input". If someone later moves this check back onto the object, that one test
 * goes red. Do not delete it to make a refactor pass.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/tools/send-arg-shape.test.ts
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';

import sendTool, { itemSpec } from './send';
import { compactSchemaForResult } from '../../tools/find';
import {
  BODY_MUST_BE_ARRAY_MESSAGE,
  messageBodyArg,
  messageSectionSchema,
  SECTION_ONLY_FIELDS,
} from '../message-fields';
import { COORD_SEND_MAX_CHUNK_PARTS, DEFAULT_INBOX_BODY_CAP } from './inbox-content-bounds';

type JsonSchemaNode = {
  $ref?: string;
  [key: string]: unknown;
};

type JsonSchemaDocument = JsonSchemaNode & {
  $defs?: Record<string, JsonSchemaNode>;
};

function resolveLocalSchemaRef(root: { $defs?: Record<string, JsonSchemaNode> }, node: unknown): JsonSchemaNode {
  let current = (node ?? {}) as JsonSchemaNode;
  const seen = new Set<string>();

  while (typeof current.$ref === 'string') {
    const ref = current.$ref;
    const prefix = '#/$defs/';
    if (!ref.startsWith(prefix) || seen.has(ref)) return current;
    seen.add(ref);
    current = root.$defs?.[ref.slice(prefix.length)] ?? current;
  }

  return current;
}

describe('EI-20223353810864057 — primary coord:send guidance names required summary', () => {
  it('describes summary as the required inbox headline on both guidance surfaces', () => {
    const description = String((sendTool as { description?: unknown }).description ?? '');
    const when = String(
      ((sendTool as { guidance?: { when?: unknown } }).guidance?.when ?? ''),
    );

    for (const text of [description, when]) {
      expect(text).toMatch(/summary[^.]{0,100}required/i);
      expect(text).toMatch(/inbox headline/i);
    }
  });

  it('also exposes the conditional requirement on the summary property schema', () => {
    // The top-level summary property is structurally optional because items[]
    // calls omit the single-message fields. Its property description must still
    // teach deferred callers that summary is required for the single form.
    const schema = z.toJSONSchema(sendTool.args) as {
      properties?: { summary?: { description?: string } };
    };
    const summaryDescription = schema.properties?.summary?.description ?? '';

    expect(summaryDescription).toMatch(/REQUIRED for the single-message form/i);
    expect(summaryDescription).toMatch(/items/);
    expect(summaryDescription).toMatch(/body.*does not replace/i);
  });

  it('projects single-send required fields into compact tools:find schema output', () => {
    const schema = z.toJSONSchema(sendTool.args);
    const compact = compactSchemaForResult(schema) ?? '';

    expect(compact).toContain(
      'constraint:$ (When `items` is omitted, top-level `to`, `summary`, and `expects` are required; when `items` is used, each item must include its own `to`, `summary`, and `expects`.)',
    );
    expect(compact).toContain('summary?:string');
  });

  it('teaches the structured why shape on every user-facing schema surface', () => {
    const description = String((sendTool as { description?: unknown }).description ?? '');
    const when = String(
      ((sendTool as { guidance?: { when?: unknown } }).guidance?.when ?? ''),
    );
    const schema = z.toJSONSchema(sendTool.args) as {
      properties?: { why?: { description?: string } };
    };
    const whyDescription = schema.properties?.why?.description ?? '';

    for (const text of [description, when, whyDescription]) {
      expect(text).toMatch(/why/i);
      expect(text).toMatch(/goalRef/);
      expect(text).toMatch(/note\?/);
    }
    expect(whyDescription).toMatch(/not prose/i);
  });
});

describe('EI-22053112169401275 — basedOn is declared output-only on every send form', () => {
  const trace = [
    { ref: 'work-item:WI-9001', via: 'work_items:get', readAt: '2026-07-27T12:00:00.000Z' },
  ];

  it('documents basedOn as output-only in description, guidance, and both schemas', () => {
    const description = String((sendTool as { description?: unknown }).description ?? '');
    const when = String(((sendTool as { guidance?: { when?: unknown } }).guidance?.when ?? ''));
    const topLevelSchema = z.toJSONSchema(sendTool.args) as {
      properties?: { basedOn?: { description?: string } };
    };
    const itemSchema = z.toJSONSchema(itemSpec) as {
      properties?: { basedOn?: { description?: string } };
    };

    for (const text of [
      description,
      when,
      topLevelSchema.properties?.basedOn?.description,
      itemSchema.properties?.basedOn?.description,
    ]) {
      expect(text ?? '').toMatch(/OUTPUT-ONLY/i);
      expect(text ?? '').toMatch(/auto-derived/i);
      expect(text ?? '').toMatch(/omit/i);
    }
  });

  it('refuses authored basedOn with a targeted correction on the single form', () => {
    const args = { to: ['peer'], summary: 'hi', expects: 'none', basedOn: trace };
    const msg = refusal(args);

    expect(paths(args)).toContain('basedOn');
    expect(msg).toMatch(/OUTPUT-ONLY/i);
    expect(msg).toMatch(/auto-derives/i);
    expect(msg).toMatch(/omit `basedOn`/);
  });

  it('refuses authored basedOn with the same correction on an items[] entry', () => {
    const args = { items: [{ to: ['peer'], summary: 'hi', expects: 'none', basedOn: trace }] };
    const msg = refusal(args);

    expect(paths(args)).toContain('items.0.basedOn');
    expect(msg).toMatch(/OUTPUT-ONLY/i);
    expect(msg).toMatch(/omit `basedOn`/);
  });

  it('keeps both valid send forms unchanged when basedOn is omitted', () => {
    expect(sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none' }).success).toBe(true);
    expect(sendTool.args.safeParse({ items: [{ to: ['peer'], summary: 'hi', expects: 'none' }] }).success).toBe(true);
  });
});

describe('EI-21335862819188804 — section-only fields name their body home', () => {
  it('full dispatch turns a misplaced couldNotDetermine into an actionable correction', async () => {
    const projected = lookupByMcpName('coord:send');
    expect(projected).toBeTruthy();

    const dispatched = await dispatchProjectedTool(
      projected!,
      'coord:send',
      {
        to: ['peer'],
        summary: 'status',
        expects: 'none',
        couldNotDetermine: [{ what: 'whether the next candidate carries the fix' }],
      },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'papercusp-workspace',
        runId: 'coord-send-section-only-redirect-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
      },
      {},
    );

    expect(dispatched.ok).toBe(false);
    expect(dispatched.error?.code).toBe('invalid_input');
    expect(dispatched.error?.message).toContain('Unrecognized key: "couldNotDetermine"');
    expect(dispatched.error?.message).toContain('body[].couldNotDetermine');
    expect(dispatched.error?.meta?.invalidInput).toEqual(
      expect.objectContaining({
        corrections: [
          expect.objectContaining({
            rejectedArg: 'couldNotDetermine',
            kind: 'authored-redirect',
          }),
        ],
      }),
    );
  });

  it.each([
    {
      field: 'youMayNotKnow',
      value: ['WI-1234'],
      expectedMessage: '`youMayNotKnow` must be an ARRAY',
    },
    {
      field: 'couldNotDetermine',
      value: ['whether the candidate carries the fix'],
      expectedMessage: '`couldNotDetermine` must be an ARRAY',
    },
  ])('full dispatch preserves a nested $field shape refusal', async ({ field, value, expectedMessage }) => {
    const projected = lookupByMcpName('coord:send');
    expect(projected).toBeTruthy();

    const dispatched = await dispatchProjectedTool(
      projected!,
      'coord:send',
      {
        to: ['peer'],
        summary: 'status',
        expects: 'none',
        body: [{ text: 'context', [field]: value }],
      },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'papercusp-workspace',
        runId: `coord-send-${field}-nested-shape-test`,
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
      },
      {},
    );

    expect(dispatched.ok).toBe(false);
    expect(dispatched.error?.message).toContain(expectedMessage);
    expect(dispatched.error?.message).not.toContain('`body` must be an ARRAY of sections');
  });

  it('redirects every section-only field to body[] instead of leaving a bare key list', () => {
    const redirects = sendTool.guidance?.argRedirects ?? {};

    for (const field of SECTION_ONLY_FIELDS) {
      expect(redirects[field], `argRedirects.${field}`).toMatch(
        new RegExp(`body\\[\\]\\.${field}`),
      );
      expect(redirects[field]).toMatch(/inside a section: body: \[\{ text:/);
    }
  });

  it('keeps section-only fields undeclared on the envelope', () => {
    const schema = z.toJSONSchema(sendTool.args) as {
      properties?: Record<string, unknown>;
    };

    for (const field of SECTION_ONLY_FIELDS) {
      expect(schema.properties, `envelope must not declare \`${field}\``).not.toHaveProperty(field);
    }
  });
});

describe('EI-23083567306363709 — `body` schema matches its runtime refusal', () => {
  type BodySchema = {
    type?: string;
    anyOf?: unknown[];
    minItems?: number;
    maxItems?: number;
  };

  it('publishes an array-only body shape on both single and items[] forms', () => {
    const schema = z.toJSONSchema(sendTool.args) as JsonSchemaDocument & {
      properties?: {
        body?: BodySchema;
        items?: { items?: { properties?: { body?: BodySchema } } };
      };
    };
    const bodies = [
      resolveLocalSchemaRef(schema, schema.properties?.body),
      resolveLocalSchemaRef(schema, schema.properties?.items?.items?.properties?.body),
    ];

    for (const body of bodies) {
      expect(body).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
      expect(body).not.toHaveProperty('anyOf');
    }
  });

  it('publishes the shared body schema once via defs and refs (EI-23318249512516833)', () => {
    const schema = z.toJSONSchema(sendTool.args, { io: 'input' }) as {
      $defs?: Record<string, unknown>;
      properties?: {
        body?: { $ref?: string };
        items?: { items?: { properties?: { body?: { $ref?: string } } } };
      };
    };
    const bodyRef = '#/$defs/coord-send-body-v1';

    expect(schema.$defs).toHaveProperty('coord-send-body-v1');
    expect(schema.properties?.body?.$ref).toBe(bodyRef);
    expect(schema.properties?.items?.items?.properties?.body?.$ref).toBe(bodyRef);
  });

  it('still refuses plain strings with the actionable array-shape message', () => {
    const inputs = [
      { to: ['peer'], summary: 'hi', expects: 'none', body: 'plain prose' },
      { items: [{ to: ['peer'], summary: 'hi', expects: 'none', body: 'plain prose' }] },
    ];

    for (const input of inputs) {
      const parsed = sendTool.args.safeParse(input);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.message === BODY_MUST_BE_ARRAY_MESSAGE)).toBe(true);
      }
    }
  });

  it('accepts the minimum structured array on both forms', () => {
    expect(
      sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none', body: [{ text: 'x' }] }).success,
    ).toBe(true);
    expect(
      sendTool.args.safeParse({ items: [{ to: ['peer'], summary: 'hi', expects: 'none', body: [{ text: 'x' }] }] }).success,
    ).toBe(true);
  });
});

describe('EI-23790900634867970 — coord:send section inputs stay typed', () => {
  type SectionInput = z.input<typeof messageSectionSchema>;
  type BodyInput = NonNullable<z.input<typeof messageBodyArg>>;
  type ItemBodyInput = NonNullable<z.input<typeof itemSpec>['body']>;

  it('keeps premises as ref strings and the neighboring knowledge fields as object arrays', () => {
    expectTypeOf<BodyInput>().toMatchTypeOf<Array<{ text: string; premises?: string[] }>>();
    expectTypeOf<ItemBodyInput>().toMatchTypeOf<Array<{ text: string; premises?: string[] }>>();
    expectTypeOf<SectionInput['premises']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<SectionInput['youMayNotKnow']>().toEqualTypeOf<
      Array<{ ref: string; provenance: 'computed' | 'authored' }> | undefined
    >();
    expectTypeOf<SectionInput['couldNotDetermine']>().toEqualTypeOf<
      Array<{ what: string; note?: string }> | undefined
    >();
  });

  it('routes provenance objects to youMayNotKnow in the short callable description', () => {
    const description = String((sendTool as { description?: unknown }).description ?? '');

    expect(description).toMatch(/body\[\]\.premises` are ref strings/i);
    expect(description).toContain('body[].forYouBecause: { relation, ref?, note? }');
    expect(description).toMatch(/body\[\]\.youMayNotKnow` uses \{ref, provenance\} objects/i);
    expect(description).toContain('put that shape in `body[].youMayNotKnow`, not in `body[].premises`');
  });
});

describe('EI-216010 — `blocking` teaches its boolean envelope shape', () => {
  it('refuses explanatory strings with the accepted literals and the detail field named', () => {
    const args = {
      to: ['peer'],
      summary: 'hi',
      expects: 'none',
      blocking: 'waiting on the validator',
    };
    const msg = refusal(args);

    expect(paths(args)).toContain('blocking');
    expect(msg).toMatch(/BOOLEAN/);
    expect(msg).toMatch(/`true`/);
    expect(msg).toMatch(/`false`/);
    expect(msg).toMatch(/`body`/);
    expect(msg).toMatch(/`body\[\]\.blockedOn`/);
    expect(msg).not.toMatch(/expected boolean, received string/i);
  });

  it.each([true, false, undefined])('still accepts blocking=%p', (blocking) => {
    expect(
      sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none', blocking }).success,
    ).toBe(true);
  });

  it('publishes the boolean contract and where blocker prose belongs', () => {
    const schema = z.toJSONSchema(sendTool.args) as {
      properties?: { blocking?: { description?: string; type?: string } };
    };
    const blockingDescription = schema.properties?.blocking?.description ?? '';

    expect(schema.properties?.blocking?.type).toBe('boolean');
    expect(blockingDescription).toMatch(/literal `true` or `false`/i);
    expect(blockingDescription).toMatch(/explanatory prose/i);
    expect(blockingDescription).toMatch(/body.*blockedOn/i);
  });
});

/** Every issue message from a failed parse, joined — order-independent matching. */
function refusal(args: unknown): string {
  const r = sendTool.args.safeParse(args);
  if (r.success) throw new Error(`expected a refusal, but the args parsed: ${JSON.stringify(args)}`);
  return r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' | ');
}

/** The dotted paths zod attributed the issues to. */
function paths(args: unknown): string[] {
  const r = sendTool.args.safeParse(args);
  if (r.success) throw new Error(`expected a refusal, but the args parsed: ${JSON.stringify(args)}`);
  return r.error.issues.map((i) => i.path.join('.'));
}

describe('WI-6522 — `wake` names its accepted values instead of "Invalid input"', () => {
  // The exact string logged 196 times across 80 senders. If this reappears, the
  // custom error on wakeArg's union has been dropped.
  it.each([['true'], ['yes'], ['Required'], ['REQUIRED'], [1], [{}]])(
    'wake=%p is refused with the accepted values named, never a bare "Invalid input"',
    (bad) => {
      const msg = refusal({ to: ['peer'], summary: 'hi', expects: 'none', wake: bad });
      expect(msg).not.toMatch(/^wake: Invalid input$/);
      expect(msg).toMatch(/required/);
      expect(msg).toMatch(/optimistic/);
    },
  );

  it('calls out the string "true" specifically — the most likely mistake, previously indistinguishable', () => {
    expect(refusal({ to: ['peer'], summary: 'hi', expects: 'none', wake: 'true' })).toMatch(
      /STRING "true" is NOT the boolean true/,
    );
  });

  it('still ACCEPTS every valid form — the fix is text-only, the shape is unchanged', () => {
    for (const good of [true, false, 'required', 'optimistic', undefined]) {
      const r = sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none', wake: good });
      expect(r.success, `wake=${JSON.stringify(good)} must still parse`).toBe(true);
    }
  });
});

describe('WI-6522 — a single-send refusal names the FIELD, not the bulk-vs-single menu', () => {
  it('missing `summary` (with `to` present) is reported ON summary, in summaryArg wording', () => {
    const args = { to: ['peer'], expects: 'none' };
    expect(paths(args)).toContain('summary');
    expect(refusal(args)).toMatch(/needs `summary`/);
    // the old generic menu must NOT be what this caller is handed
    expect(refusal(args)).not.toMatch(/for many distinct messages/);
  });

  it('an EMPTY-STRING summary is the same mistake and gets the same specific answer', () => {
    const args = { to: ['peer'], summary: '', expects: 'none' };
    expect(paths(args)).toContain('summary');
    expect(refusal(args)).toMatch(/needs `summary`/);
  });

  it('missing `to` (with `summary` present) is reported ON to', () => {
    const args = { summary: 'hi', expects: 'none' };
    expect(paths(args)).toContain('to');
    expect(refusal(args)).toMatch(/needs `to`/);
    expect(refusal(args)).not.toMatch(/for many distinct messages/);
  });

  it('an EMPTY `to` array is the same mistake as a missing one', () => {
    const args = { to: [], summary: 'hi', expects: 'none' };
    expect(paths(args)).toContain('to');
  });

  it('`items: []` says the array is empty rather than the generic menu', () => {
    const args = { items: [] };
    expect(paths(args)).toContain('items');
    expect(refusal(args)).toMatch(/EMPTY array/);
  });

  it('a call with NOTHING addressed still gets the bulk-vs-single menu — the genuinely ambiguous case', () => {
    expect(refusal({})).toMatch(/for many distinct messages/);
  });
});

describe('WI-6522 — `body` passed instead of `summary` is named explicitly', () => {
  // Two fresh instances inside ten minutes from two different agents on
  // 2026-07-27 — `body` reads as the obvious field name, and the old refusal
  // never said "summary is missing".
  it('{ to, body } tells the caller body does not satisfy summary', () => {
    const msg = refusal({ to: ['peer'], body: 'the long form text', expects: 'none' });
    expect(msg).toMatch(/needs `summary`/);
    expect(msg).toMatch(/`body`/);
    expect(msg).toMatch(/does NOT satisfy `summary`/);
  });

  it('the same hint rides along on the ambiguous menu when body is the only content given', () => {
    expect(refusal({ body: 'text', expects: 'none' })).toMatch(/does NOT satisfy `summary`/);
  });

  it('is NOT emitted when body is absent — the hint must not become noise on every refusal', () => {
    expect(refusal({ to: ['peer'], expects: 'none' })).not.toMatch(/`body`/);
  });
});

describe('WI-6522 — the branch fires only for MISSING, never for wrong-typed', () => {
  it('a wrong-typed summary falls through to summaryArg’s own type error, not the missing-field branch', () => {
    // Boolean(5) is true, so this is "present but wrong type" — summaryArg owns it.
    const args = { to: ['peer'], summary: 5, expects: 'none' };
    expect(paths(args)).toContain('summary');
    expect(refusal(args)).not.toMatch(/for many distinct messages/);
  });
});

describe('EI-18887930700345699 — independent omissions are reported TOGETHER, not one per round-trip', () => {
  // The `expects` gate keys on `to` being present, NOT on `summary` having landed:
  // the two omissions are independent, so making the second wait for the first to be
  // fixed cost a whole round-trip (and a re-send of the entire body) to learn a fact
  // the validator already knew. coord:send is a DEFERRED tool, so a first-time caller
  // has no schema in context and discovers the envelope purely from these errors.
  it('a call missing BOTH summary and expects names both in ONE refusal', () => {
    const args = { to: ['peer'], body: 'some long body' };
    expect(paths(args)).toContain('summary');
    expect(paths(args)).toContain('expects');
  });

  it('still names expects when only expects is missing', () => {
    expect(paths({ to: ['peer'], summary: 's' })).toContain('expects');
  });

  it('does NOT demand expects when there is no single-send to attach it to', () => {
    // No `to` and no `items` — the caller gets the bulk-vs-single menu, and adding a
    // second complaint about `expects` here would be noise about a message shape they
    // have not chosen yet.
    expect(paths({ summary: 's' })).not.toContain('expects');
  });

  it('does NOT demand expects on an items[]-only call (itemSpec owns that axis)', () => {
    const r = sendTool.args.safeParse({ items: [{ to: ['peer'], summary: 's', expects: 'none' }] });
    expect(r.success).toBe(true);
  });
});

describe('WI-6522 — regression pins that must not be traded away', () => {
  it('preserves EI-7838 precedence: a missing `summary` is STILL reported when `wake` also fails', () => {
    // This is the whole reason the check lives in a z.preprocess. A trailing
    // .refine() is short-circuited by the sibling `wake` failure, which would send
    // the caller chasing "wake: Invalid input" while the real, actionable problem
    // (no summary) went unreported. If this goes red, the check was moved.
    const msg = refusal({ to: ['peer'], expects: 'none', wake: 'true' });
    expect(msg).toMatch(/needs `summary`/);
  });

  it('`expects` is still REQUIRED for the single form, with its four values named (D-016/D-048)', () => {
    const msg = refusal({ to: ['peer'], summary: 'hi' });
    expect(paths({ to: ['peer'], summary: 'hi' })).toContain('expects');
    for (const v of ['ack', 'answer', 'action', 'none']) expect(msg).toMatch(new RegExp(`'${v}'`));
  });

  it('a fully-valid single send parses — the accepted shape is unchanged', () => {
    expect(
      sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none' }).success,
    ).toBe(true);
  });

  it('a fully-valid items[] send parses, and needs no top-level to/summary/expects', () => {
    expect(
      sendTool.args.safeParse({ items: [{ to: ['peer'], summary: 'hi', expects: 'none' }] }).success,
    ).toBe(true);
  });

  describe('EI-21579316360433950 — per-message harness federation scope', () => {
    const base = { to: ['peer'], summary: 'hi', expects: 'none' as const };

    it('accepts harness on both the single form and an items[] entry', () => {
      expect(sendTool.args.safeParse({ ...base, harness: 'target-harness' }).success).toBe(true);
      expect(
        sendTool.args.safeParse({ items: [{ ...base, harness: 'target-harness' }] }).success,
      ).toBe(true);
    });

    it('accepts a top-level harness default alongside items[]', () => {
      expect(
        sendTool.args.safeParse({ harness: 'default-harness', items: [base] }).success,
      ).toBe(true);
    });

    it('still refuses an empty harness value', () => {
      expect(sendTool.args.safeParse({ ...base, harness: '' }).success).toBe(false);
      expect(sendTool.args.safeParse({ items: [{ ...base, harness: '' }] }).success).toBe(false);
    });
  });

  describe('EI-21883551367092231 — `harness_slug` accepted as a synonym for `harness`', () => {
    const base = { to: ['peer'], summary: 'hi', expects: 'none' as const };

    it('accepts harness_slug on the single form and normalizes it to harness', () => {
      const r = sendTool.args.safeParse({ ...base, harness_slug: 'target-harness' });
      expect(r.success).toBe(true);
      if (r.success) {
        expect((r.data as { harness?: string }).harness).toBe('target-harness');
        expect('harness_slug' in (r.data as object)).toBe(false);
      }
    });

    it('accepts harness_slug on an items[] entry and normalizes it too', () => {
      const r = sendTool.args.safeParse({ items: [{ ...base, harness_slug: 'target-harness' }] });
      expect(r.success).toBe(true);
      if (r.success) {
        const item = (r.data as { items: Array<{ harness?: string }> }).items[0];
        expect(item.harness).toBe('target-harness');
        expect('harness_slug' in item).toBe(false);
      }
    });

    it('an explicit harness wins when both harness and harness_slug are passed', () => {
      const r = sendTool.args.safeParse({ ...base, harness: 'explicit', harness_slug: 'alias' });
      expect(r.success).toBe(true);
      if (r.success) expect((r.data as { harness?: string }).harness).toBe('explicit');
    });

    it('is a pure alias, not a new advertised field — the schema still only names harness', () => {
      const schema = z.toJSONSchema(sendTool.args) as { properties?: Record<string, unknown> };
      expect(schema.properties).toHaveProperty('harness');
      expect(schema.properties).not.toHaveProperty('harness_slug');
    });
  });

  // P-013 — expectEffect. The schema is the ONLY place an uninterpretable expectation
  // can be stopped: once stamped on the envelope it is read back by a probe that must
  // either produce a verdict or skip the row, and a silently-skipped expectation is
  // indistinguishable from "the leader never asked".
  describe('expectEffect (P-013)', () => {
    const base = { to: ['peer'], summary: 'hi', expects: 'action' as const, body: [{ text: 'x', forYouBecause: { relation: 'other', note: 'y' } }] };

    it('accepts each declared effect kind on the single form', () => {
      for (const kind of ['checkpoint', 'claim-release', 'terminal']) {
        expect(sendTool.args.safeParse({ ...base, expectEffect: { kind, itemId: 'WI-1' } }).success).toBe(true);
      }
    });

    it('accepts it on an items[] entry too — the two axes must not diverge', () => {
      expect(
        sendTool.args.safeParse({
          items: [{ ...base, expectEffect: { kind: 'checkpoint', itemId: 'WI-1' } }],
        }).success,
      ).toBe(true);
    });

    it('REFUSES an unrecognised kind', () => {
      expect(sendTool.args.safeParse({ ...base, expectEffect: { kind: 'lock-taken', itemId: 'WI-1' } }).success).toBe(false);
    });

    it('REFUSES a missing or empty itemId — an effect with no subject is unverifiable', () => {
      expect(sendTool.args.safeParse({ ...base, expectEffect: { kind: 'checkpoint' } }).success).toBe(false);
      expect(sendTool.args.safeParse({ ...base, expectEffect: { kind: 'checkpoint', itemId: '' } }).success).toBe(false);
    });

    it('REFUSES an unknown key (.strict) rather than silently ignoring it', () => {
      expect(
        sendTool.args.safeParse({ ...base, expectEffect: { kind: 'checkpoint', itemId: 'WI-1', by: 'soon' } }).success,
      ).toBe(false);
    });

    it('stays entirely OPTIONAL — every existing send shape is unaffected', () => {
      expect(sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none' }).success).toBe(true);
    });
  });
});

/**
 * EI-19295149246007753 — field-name PARITY between the items[] axis (`itemSpec`,
 * the canonical field set) and the top-level single-form object schema.
 *
 * The single form used to be built from a hand-listed ~30-field object literal,
 * independent of `itemSpec` — a field added to itemSpec but forgotten there
 * validated fine (ok:true) and then silently vanished before sendOne ever saw
 * it. That mapping was fixed structurally: the single-form SendMsg is now
 * derived by copying itemSpec's own field names off `args` (see send.ts's
 * EI-19295149246007753 comment), so a value-level drop can no longer happen
 * for a field the top-level SCHEMA actually declares.
 *
 * The residual risk this test guards: a field added to `itemSpec` but never
 * mirrored onto the top-level object schema below it. zod strips unrecognised
 * top-level keys by DEFAULT (no error), so such a field would still validate on
 * items[], while a single-form caller's value is stripped before the handler
 * — or even the field-copy loop above — ever runs. This asserts every itemSpec
 * key is also a top-level schema key, at the SCHEMA level (`.def.out.shape`,
 * zod v4's introspectable inner object of the `z.preprocess` wrapper) rather
 * than by re-auditing a hand-kept list, so a forgotten mirror reds this test
 * instead of shipping a silent drop.
 */
describe('EI-19295149246007753 — single-form schema mirrors every itemSpec field', () => {
  it('every itemSpec key is ALSO declared on the top-level (single-form) object schema', () => {
    const itemKeys = Object.keys(itemSpec.shape).sort();
    const topLevelShape = (sendTool.args as unknown as { def: { out: { shape: Record<string, unknown> } } }).def.out
      .shape;
    const topLevelKeys = Object.keys(topLevelShape);
    const missing = itemKeys.filter((k) => !topLevelKeys.includes(k));
    expect(
      missing,
      `itemSpec field(s) ${JSON.stringify(missing)} are NOT declared on the top-level single-form schema — ` +
        'a single-form caller passing this field has it silently stripped by zod before the handler runs. ' +
        'Add it to the z.object({...}) literal alongside the other …Arg fields in send.ts.',
    ).toEqual([]);
  });

  it('sanity: itemSpec is non-trivial (guards the introspection path itself from silently matching an empty set)', () => {
    expect(Object.keys(itemSpec.shape).length).toBeGreaterThan(10);
  });
});

/**
 * EI-21656724796029687 — the conditional `forYouBecause` requirement must be
 * SIGNPOSTED where it is keyed, not only taught by the refusal.
 *
 * The reporter filed this a MONTH after the refusal text landed (2026-07-28,
 * acf32dfb): they received the full diagnostic — which names the requirement, the
 * shape, the 'other' escape hatch and the exemptions — and still filed, because the
 * complaint is not about the refusal. It is that nothing in the ARG SCHEMA says the
 * field is conditionally required, so the first a caller learns of it is a dropped
 * send. A rejected coord:send is a dropped message (see this file's header), so the
 * cost is one silent coordination loss per agent that meets it.
 *
 * This guard COUPLES the two halves: the enforcement and its signpost. Either one
 * disappearing reds this test, which is the point — a signpost that drifts away from
 * the rule it describes is worse than none, and enforcement with no signpost is the
 * defect this row reported.
 */
describe('EI-21656724796029687 — forYouBecause is signposted on `expects`, not only in the refusal', () => {
  const bareSection = { text: 'x' };

  it('ENFORCES it: a directed action/answer with no forYouBecause on any section is refused', () => {
    for (const expects of ['action', 'answer'] as const) {
      const parsed = sendTool.args.safeParse({
        to: ['peer'],
        summary: 'hi',
        expects,
        body: [bareSection],
      });
      expect(parsed.success, `expects:'${expects}' with no forYouBecause must be refused`).toBe(false);
    }
  });

  it('SIGNPOSTS it: the `expects` arg description names forYouBecause and its exemptions', () => {
    const description = String((sendTool as { description?: unknown }).description ?? '');
    const schema = z.toJSONSchema(sendTool.args) as {
      properties?: { expects?: { description?: string } };
    };
    const expectsDescription = schema.properties?.expects?.description ?? '';
    expect(description.slice(0, 100)).toMatch(/directed action\/answer requires `body\[\]\.forYouBecause: \{ relation, ref\?, note\? \}`/i);
    expect(
      expectsDescription,
      'the `expects` arg description must name `forYouBecause` — the requirement is keyed on ' +
        'expects, so this is where a caller composing the call will look. Without it the rule is ' +
        'discoverable only by getting a message dropped.',
    ).toContain('forYouBecause');
    // The exemptions matter as much as the rule: an agent who reads "required" without
    // them over-applies it to broadcasts and FYIs, which is a different wrong call.
    expect(expectsDescription.toLowerCase()).toContain('exempt');
  });

  it('still ACCEPTS a directed action carrying forYouBecause (the rule is conditional, not blanket)', () => {
    const parsed = sendTool.args.safeParse({
      to: ['peer'],
      summary: 'hi',
      expects: 'action',
      body: [{ text: 'x', forYouBecause: { relation: 'other', note: 'y' } }],
    });
    expect(parsed.success).toBe(true);
  });

  it('does NOT require it for the exempt dispositions — expects:none and ack parse without it', () => {
    for (const expects of ['none', 'ack'] as const) {
      const parsed = sendTool.args.safeParse({
        to: ['peer'],
        summary: 'hi',
        expects,
        body: [bareSection],
      });
      expect(parsed.success, `expects:'${expects}' is exempt and must parse`).toBe(true);
    }
  });
});

describe("EI-22369606583733422 — the expects!=='none' body cap is discoverable BEFORE the send", () => {
  // Measured 2026-09-05: five rejections across two messages in one session.
  // The cap was enforced in two places and documented only in `returns` — which
  // a composer reads AFTER the refusal. The body schema described shape at
  // length and never mentioned a length limit at all, so the only way to learn
  // it was to lose a load-bearing message to it.
  //
  // The assertions below are pinned to the DERIVED constant, not to the literal
  // 600. That is the point: if the cap ever moves, an interpolated description
  // follows it automatically and these stay green, while a description that
  // hardcoded a stale number goes red instead of quietly lying to callers.
  const bodyDescriptions = (): Record<string, string> => {
    const schema = z.toJSONSchema(sendTool.args) as JsonSchemaDocument & {
      properties?: {
        body?: { description?: string };
        items?: { items?: { properties?: { body?: { description?: string } } } };
      };
    };
    return {
      'top-level body': String(resolveLocalSchemaRef(schema, schema.properties?.body).description ?? ''),
      'items[].body': String(
        resolveLocalSchemaRef(schema, schema.properties?.items?.items?.properties?.body).description ?? '',
      ),
    };
  };

  /**
   * The predicate, extracted so it can be aimed at a KNOWN-BAD control as well
   * as at the live schema. A guard that has only ever been pointed at the fixed
   * text is a guard nobody has tested; the control below is what makes this one
   * falsifiable without mutating a file in the shared tree (git-sync sweeps the
   * whole tree on a timer, so an in-tree mutation probe can be committed by a
   * sweep even when nothing goes wrong).
   */
  const capTeachingFailures = (description: string): string[] => {
    const failures: string[] = [];
    if (description === '') failures.push('empty');
    // The NUMBER a caller needs, carried from the constant the refusal enforces.
    if (!description.includes(String(DEFAULT_INBOX_BODY_CAP))) failures.push('no cap value');
    // RSR-P-008-B: an over-cap body is chunked, not refused. The caller needs to
    // know it arrives as PARTS, how many parts the limit is, and that only the
    // final part carries the ask — or they keep splitting messages by hand.
    if (!description.includes(String(COORD_SEND_MAX_CHUNK_PARTS))) failures.push('no part limit');
    if (!/parts/i.test(description)) failures.push('chunking not stated');
    if (!/final part/i.test(description)) failures.push('ask placement not stated');
    // The CONSEQUENCE past the part limit: nothing is sent at all.
    if (!/refus|reject|nothing is sent/i.test(description)) failures.push('refusal not stated');
    return failures;
  };

  it('states the real cap on every body schema surface a caller composes against', () => {
    for (const [surface, description] of Object.entries(bodyDescriptions())) {
      expect(capTeachingFailures(description), `${surface} must teach the cap`).toEqual([]);
    }
  });

  it('names durable long-form routes on every body schema surface', () => {
    for (const [surface, description] of Object.entries(bodyDescriptions())) {
      expect(description, surface).toContain('work_items:comment');
      expect(description, surface).toContain('coord:message-agent');
      expect(description, surface).toMatch(/short pointer/);
    }
  });

  it('CONTROL — the pre-fix description (shape only, no length) fails this predicate', () => {
    // Verbatim tail of the description as it shipped before this fix. It is a
    // thorough, careful paragraph about SHAPE — which is exactly why the gap was
    // invisible: nothing about it looks incomplete. If a future rewrite drops the
    // length sentence, the live schema regresses to this string's behaviour and
    // the test above goes red instead of silently passing.
    const preFix =
      'The message body: an ARRAY of sections. A plain string is REFUSED — the minimum is ' +
      '[{ text: "..." }]. Use SEVERAL sections when the parts of your message have different ' +
      'dispositions — a concession, an experimental result, an explicitly-undetermined claim — ' +
      'each with its own `premises`, `forYouBecause`, `youMayNotKnow`, `couldNotDetermine`, ' +
      '`clarify`. The ENVELOPE fields (expects, blocking, why, basedOn) stay on the message and ' +
      'are refused on a section.';

    // Note it already contained "expects" and "REFUSED" (about SHAPE, not length)
    // — so a laxer predicate would have passed it and proved nothing. The cap
    // VALUE is the assertion carrying the weight here.
    expect(capTeachingFailures(preFix)).toContain('no cap value');
  });

  it('the documented limit is the one actually enforced — schema text and refusal agree', () => {
    // Falsifiable end-to-end, for every expects: a body just over the inbox cap
    // now PARSES (the handler chunks it), and a body needing more than the
    // documented part limit is refused. If the description and the enforcement
    // disagree, one of these goes red.
    for (const expects of ['action', 'none'] as const) {
      const section = (text: string) =>
        expects === 'action' ? { text, forYouBecause: { relation: 'same-fleet' as const } } : { text };
      const overBy1 = sendTool.args.safeParse({
        to: ['peer'],
        summary: 'hi',
        expects,
        body: [section('x'.repeat(DEFAULT_INBOX_BODY_CAP + 1))],
      });
      expect(overBy1.success, `expects:'${expects}' one char over the cap is chunked, not refused`).toBe(true);

      const tooManyParts = sendTool.args.safeParse({
        to: ['peer'],
        summary: 'hi',
        expects,
        body: [section('x'.repeat(DEFAULT_INBOX_BODY_CAP * (COORD_SEND_MAX_CHUNK_PARTS + 1)))],
      });
      expect(tooManyParts.success, `expects:'${expects}' past the part limit must be refused`).toBe(false);
    }
  });
});

describe('WI-10005668 — a bare-string `to` is normalized, not misreported as missing', () => {
  // Measured 24h of tool_invocations: `to: "su-…"` (a scalar recipient) was refused 13x
  // and re-failed 11 times, because `toPresent` was Array.isArray-only so the caller
  // who HAD passed a recipient was told "needs `to`: at least one recipient id".
  const dataTo = (args: unknown): unknown => {
    const r = sendTool.args.safeParse(args);
    return r.success ? (r.data as { to?: unknown }).to : undefined;
  };

  it('accepts a bare-string `to` on the single form and delivers it as a one-element array', () => {
    expect(sendTool.args.safeParse({ to: 'su-peer', summary: 'hi', expects: 'none' }).success).toBe(true);
    expect(dataTo({ to: 'su-peer', summary: 'hi', expects: 'none' })).toEqual(['su-peer']);
  });

  it('accepts a bare-string `to` on an items[] entry too', () => {
    const args = { items: [{ to: '@fleet:alpha', summary: 'hi', expects: 'none' }] };
    const r = sendTool.args.safeParse(args);
    expect(r.success).toBe(true);
    expect((r.data as { items: Array<{ to: unknown }> }).items[0]?.to).toEqual(['@fleet:alpha']);
  });

  it('does NOT let the normalization bypass the directed forYouBecause gate', () => {
    // The scalar becomes a one-element DIRECTED array BEFORE checkStructured runs, so
    // expects:'action' with no forYouBecause section is still refused — normalizing
    // `to` must never be a way around a gate the array form hits.
    const args = { to: 'su-peer', summary: 'hi', expects: 'action', body: [{ text: 'do it' }] };
    const r = sendTool.args.safeParse(args);
    expect(r.success).toBe(false);
    expect(refusal(args)).toMatch(/forYouBecause/);
  });

  it('keeps the array form working and keeps genuinely missing/empty/wrong-typed `to` refused', () => {
    expect(dataTo({ to: ['su-peer'], summary: 'hi', expects: 'none' })).toEqual(['su-peer']);
    for (const bad of ['', 5, null, []] as const) {
      const args = { to: bad, summary: 'hi', expects: 'none' };
      expect(sendTool.args.safeParse(args).success, `to: ${JSON.stringify(bad)} must stay refused`).toBe(false);
    }
    expect(paths({ summary: 'hi', expects: 'none' })).toContain('to');
  });
});
