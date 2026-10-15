/**
 * field-writer-redirects.test.ts — the work_items verbs that REFUSE a field write, and
 * the redirects that name the verb which performs it.
 *
 * THE SHARED DEFECT (EI-21829130743047093, EI-21828065229363197, EI-21307426619986295 —
 * three independent filings, one shape). Each caller reached for a real, existing
 * work-item FIELD on a verb that does not write fields:
 *
 *   work_items:release { checkpoint }  — hand the item back AND leave the note
 *   work_items:create  { goal }        — file the item INTO a goal's drain lane
 *   work_items:amend   { parent }      — re-parent a completed duplicate
 *
 * Every one is a coherent intention, and every one is a capability boundary rather than
 * a rename: release ends a hold, create cannot see a goal that is stamped after its own
 * insert (WI-37711), and amend records a decision about a node without editing it. So
 * the remedy is to NAME THE WRITER, never to widen the schema — accepting the key would
 * mean accepting a value the verb cannot store, which is the undeclared-arg hazard the
 * strict-args rail exists to prevent.
 *
 * WHY THE BARE REJECTION COULD NOT HELP. `suggestArgName` only finds near-misses among
 * declared keys, and none of these three has one, so the caller got a list of accepted
 * keys and no pointer. Read literally that says "this system has no goal / no parent /
 * no checkpoint", while all three are real fields one call away.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A PRESENCE CHECK. A cross-tool redirect is a promise
 * about ANOTHER tool's schema, so it rots from a distance: rename `work_items:update`'s
 * `parent`, and this redirect starts sending callers to a tool that will reject them
 * exactly as amend did — a redirect that reproduces the defect it was filed to fix, with
 * no local edit to notice. So each case asserts the TARGET actually declares the key,
 * against the target's live schema. It also asserts the key is still ABSENT from the
 * source: a redirect for a key the tool later accepts is dead prose that contradicts the
 * schema.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/field-writer-redirects.test.ts
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { splitLocalSchemaTarget, toJsonSchema } from '@papercusp/tooldef';
import releaseTool from './release';
import createTool from './create';
import amendTool from './amend';
import setStateTool from './set_state';
import updateTool from './update';
import checkpointTool from './checkpoint';

type Redirect = string | { tool?: unknown; args?: unknown; note?: unknown };
type ToolLike = {
  name: string;
  args?: unknown;
  guidance?: { argRedirects?: Record<string, Redirect> };
};

/** Use the same version-aware adapter as the tool catalog, including union variants. */
function argKeys(tool: ToolLike): string[] {
  const keys = new Set<string>();
  function collect(node: unknown, depth = 0): boolean {
    if (!node || typeof node !== 'object' || depth >= 8) return false;
    const schema = node as Record<string, unknown>;
    let foundObject = false;
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      Object.keys(schema.properties).forEach((key) => keys.add(key));
      foundObject = true;
    }
    for (const kind of ['anyOf', 'oneOf', 'allOf']) {
      const variants = schema[kind];
      if (Array.isArray(variants)) {
        for (const variant of variants) foundObject = collect(variant, depth + 1) || foundObject;
      }
    }
    return foundObject;
  }
  if (collect(toJsonSchema(tool.args))) return [...keys].sort();
  throw new Error(`could not read an object shape from ${tool.name}'s args schema`);
}

describe('declared argument inspection', () => {
  it('reads actual keys through object refinements', () => {
    const args = z.object({ id: z.string(), note: z.string().optional() }).superRefine(() => {});
    expect(argKeys({ name: 'fixture:refined', args })).toEqual(['id', 'note']);
  });

  it('includes declarations from every object union variant without inventing aliases', () => {
    const args = z.union([
      z.object({ id: z.string(), reason: z.string() }).strict(),
      z.object({ ids: z.array(z.string()), note: z.string() }).refine(() => true),
    ]);
    expect(argKeys({ name: 'fixture:union', args })).toEqual(['id', 'ids', 'note', 'reason']);
    const withoutAliases = z.union([
      z.object({ id: z.string() }),
      z.object({ ids: z.array(z.string()) }),
    ]);
    expect(argKeys({ name: 'fixture:without-aliases', args: withoutAliases })).toEqual(['id', 'ids']);
  });

  it('fails closed when the schema has no object argument shape', () => {
    expect(() => argKeys({ name: 'fixture:scalar', args: z.string() })).toThrow(
      "could not read an object shape from fixture:scalar's args schema",
    );
  });
});

function redirect(tool: ToolLike, key: string): Redirect {
  const found = tool.guidance?.argRedirects?.[key];
  if (found === undefined) throw new Error(`${tool.name} declares no argRedirect for '${key}'`);
  return found;
}

const TOOLS: Record<string, ToolLike> = {
  'work_items:update': updateTool as ToolLike,
  'work_items:checkpoint': checkpointTool as ToolLike,
};

/**
 * The load-bearing assertion. A cross-tool redirect makes three claims at once — that
 * the key is not ours, that the named tool exists, and that IT takes the key we tell the
 * caller to pass. Checking only the first two leaves the caller's actual next call
 * unverified, which is the hop that was broken to begin with.
 */
function expectCrossToolRedirect(
  source: ToolLike,
  key: string,
  expected: { tool: string; targetKey: string },
) {
  const entry = redirect(source, key);

  // Object form, not the string form: a string target is read as a LOCAL relocation
  // ("pass it as `x` instead"), which would tell a caller who used the wrong key on the
  // RIGHT tool that some other tool owns their data (plan D-004).
  expect(typeof entry, `${source.name}.${key} must use the { tool, args, note } form`).toBe('object');
  const obj = entry as { tool?: unknown; args?: unknown; note?: unknown };
  expect(obj.tool).toBe(expected.tool);
  expect(typeof obj.note).toBe('string');
  expect((obj.note as string).length).toBeGreaterThan(0);

  // The key is genuinely not ours — otherwise the redirect contradicts our own schema.
  expect(argKeys(source)).not.toContain(key);

  // …and the target really does accept what we are sending them, both in the worked
  // `args` example and in the target's live schema.
  const target = TOOLS[expected.tool];
  expect(target, `no live tool registered in this test for ${expected.tool}`).toBeDefined();
  expect(argKeys(target as ToolLike)).toContain(expected.targetKey);
  expect(Object.keys((obj.args ?? {}) as Record<string, unknown>)).toContain(expected.targetKey);
}

describe('work_items field-writer redirects — the key belongs to another verb', () => {
  it('release { checkpoint } points at the verb that persists the note', () => {
    expectCrossToolRedirect(releaseTool as ToolLike, 'checkpoint', {
      tool: 'work_items:checkpoint',
      targetKey: 'checkpoint',
    });
  });

  it('create { goal } points at the verb that adopts an item into a goal', () => {
    expectCrossToolRedirect(createTool as ToolLike, 'goal', {
      tool: 'work_items:update',
      targetKey: 'goal',
    });
  });

  it('amend { parent } points at the verb that writes the parent edge', () => {
    expectCrossToolRedirect(amendTool as ToolLike, 'parent', {
      tool: 'work_items:update',
      targetKey: 'parent',
    });
  });
});

describe('the local/cross-tool split stays honest (plan D-004)', () => {
  it("create's `paths` stays a LOCAL relocation, not a cross-tool hop", () => {
    // The pre-existing sibling redirect, and the control for the branch above: `paths`
    // really is written here, into a declared key, so it must keep taking the local
    // branch. If this ever flips, the two shapes are being authored interchangeably and
    // the assertions above stop discriminating.
    const entry = redirect(createTool as ToolLike, 'paths');
    expect(typeof entry).toBe('string');
    const split = splitLocalSchemaTarget(entry as string, argKeys(createTool as ToolLike));
    expect(split, '`paths` must resolve against a declared key of work_items:create').not.toBeNull();
    expect(split?.path).toBe('payload.paths');
  });

  it('every cross-tool redirect target is a real tool name, never a bare local key', () => {
    // A cross-tool `tool:` value that happened to name one of OUR keys would render as a
    // relocation into ourselves. Cheap to assert, and it fails loudly on a copy-paste.
    for (const [source, key] of [
      [releaseTool as ToolLike, 'checkpoint'],
      [createTool as ToolLike, 'goal'],
      [amendTool as ToolLike, 'parent'],
    ] as const) {
      const name = (redirect(source, key) as { tool: string }).tool;
      expect(name).toMatch(/^[a-z_]+:[a-z_]+$/);
      expect(argKeys(source)).not.toContain(name);
    }
  });
});

describe('controls — these assertions can actually fail', () => {
  // A guard that has never failed is a guard nobody has tested, and every check above is
  // an `expect(...).toContain(...)` that would pass just as quietly against a schema read
  // that silently returned the wrong thing. These controls are deliberately-wrong inputs
  // kept permanently in the file (never a mutation of the shared tree: git-sync sweeps it
  // every few minutes, so a probe that edits a real module can be committed mid-probe).

  it('rejects a redirect whose target tool does NOT declare the key it names', () => {
    // The exact rot this file exists to catch, staged: same real redirect, one wrong
    // target key. If this stops throwing, the cross-file half is no longer checking
    // anything and the three tests above are presence checks wearing a costume.
    expect(() =>
      expectCrossToolRedirect(amendTool as ToolLike, 'parent', {
        tool: 'work_items:update',
        targetKey: 'no_such_key_on_update',
      }),
    ).toThrow();
  });

  it('rejects a redirect authored in the string form where a cross-tool hop is required', () => {
    const fake: ToolLike = {
      name: 'fake:tool',
      args: (createTool as ToolLike).args,
      guidance: { argRedirects: { goal: 'work_items:update — adopt it there' } },
    };
    expect(() =>
      expectCrossToolRedirect(fake, 'goal', { tool: 'work_items:update', targetKey: 'goal' }),
    ).toThrow();
  });

  it('splitLocalSchemaTarget returns null for a cross-tool target — the negative half', () => {
    // Pairs with the `paths` case above, which asserts the non-null branch. Both
    // directions matter: a function that always returned non-null would pass that test,
    // and one that always returned null would pass nothing here without this line.
    expect(splitLocalSchemaTarget('work_items:update', argKeys(createTool as ToolLike))).toBeNull();
  });
});

describe('set_state { reason } — already remediated, and pinned so it stays that way', () => {
  it('accepts `reason` and `note` as declared completionRef aliases', () => {
    // EI-21193128660436310 filed `reason` as an unrecognized key. It is now DECLARED
    // (_completion-ref-alias.ts), which is why that filing closes with no code change —
    // 53 of the 59 bare rejections in that burst named this one key. Pinning it here is
    // what makes the close falsifiable: drop the alias and the class re-opens silently,
    // because the only surviving record would be a closed work-item's prose.
    const keys = argKeys(setStateTool as ToolLike);
    expect(keys).toContain('reason');
    expect(keys).toContain('note');
    expect(keys).toContain('completionRef');
  });
});
