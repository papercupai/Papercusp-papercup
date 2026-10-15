/**
 * cache-policy-relocate-tail.test.ts — the OFFLINE fixture for WI-10005042 (plan
 * cache-efficiency-and-accounting-2026-09-23 D-078/D-079, R-10 residue): relocating the per-owner
 * system tail behind message 0's shared first block.
 *
 * This is the byte-equality + prefix-identity fixture the work-item required BEFORE any live
 * experiment. It makes NO provider request. The quality half (does the model weight the
 * relocated text like system text?) cannot be proven offline — it is the D-073-gated experiment.
 *
 * Run: npm run test:file -- packages/operator-core/lib/inference-gateway/cache-policy-relocate-tail.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  PSU_CACHE_BOUNDARY,
  RELOCATED_TAIL_CLOSE,
  RELOCATED_TAIL_OPEN,
  relocateSystemTailEnabled,
  relocateSystemTailToFirstUserTurn,
  resolveRelocateSystemTail,
  rewriteAnthropicCacheBody,
} from './cache-policy';

// token-efficiency-prompts-cache-and-behavior-2026-10-11 P-015 / R-3: the gateway's decision is
// the registered flag, with the per-host env var as a forcing override.
describe('resolveRelocateSystemTail — registered flag + env override', () => {
  const flag = (v: boolean) => async () => v;
  it('follows the flag when no env override is set', async () => {
    expect(await resolveRelocateSystemTail(flag(true), {})).toBe(true);
    expect(await resolveRelocateSystemTail(flag(false), {})).toBe(false);
  });
  it('lets the env var force it on or off regardless of the flag', async () => {
    expect(await resolveRelocateSystemTail(flag(false), { PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '1' })).toBe(true);
    expect(await resolveRelocateSystemTail(flag(true), { PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '0' })).toBe(false);
  });
  it('keeps the previous layout when the flag read fails', async () => {
    const boom = async (): Promise<boolean> => { throw new Error('flag store down'); };
    expect(await resolveRelocateSystemTail(boom, {})).toBe(false);
  });
});

type Body = Record<string, any>;
const eph = (ttl?: string) => (ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' });

const STABLE_PERSONA = 'stable persona line\n'.repeat(300);
/** Stands in for message 0 block 0 — the ~138 KB CLAUDE.md reminder, byte-identical across owners. */
const SHARED_BLOCK0 = '<system-reminder>\nshared project instructions\n'.repeat(400) + '</system-reminder>';
const tailFor = (owner: string) =>
  `\n\n# Operating brief — this launch\n- owner ${owner}\n\n# Carry document\nowner-specific state for ${owner}\n`;

/** A Claude-Code-shaped request: 3 pre-split system blocks, shared msg0 block 0, per-owner block 1. */
function startupBody(owner: string, opts: { extraMessages?: number; tools?: string[] } = {}): Body {
  const messages: Body[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: SHARED_BLOCK0 },
        { type: 'text', text: `first prompt for ${owner}`, cache_control: eph() },
      ],
    },
  ];
  for (let i = 0; i < (opts.extraMessages ?? 0); i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `u${i}`, ...(i === (opts.extraMessages ?? 0) - 1 ? { cache_control: eph() } : {}) }],
    });
  }
  return {
    model: 'claude-opus-5-5',
    tools: (opts.tools ?? ['a', 'b']).map((name) => ({ name, input_schema: {} })),
    system: [
      { type: 'text', text: 'billing header' },
      { type: 'text', text: 'You are Claude Code', cache_control: eph() },
      { type: 'text', text: STABLE_PERSONA + PSU_CACHE_BOUNDARY + tailFor(owner), cache_control: eph() },
    ],
    messages,
  };
}

const run = (b: Body, relocate = true) => {
  const r = rewriteAnthropicCacheBody(Buffer.from(JSON.stringify(b)), { splitBoundary: true, relocateSystemTail: relocate });
  return { out: JSON.parse(r.body.toString('utf8')) as Body, stats: r.stats };
};

/** Everything provider-prefix-relevant up to and including msg0 block 0. cache_control is not part
 *  of a prefix hash, so it is stripped — identity here is identity of CONTENT. */
const prefixThroughBlock0 = (b: Body) =>
  JSON.stringify(
    { tools: b.tools, system: b.system, m0b0: b.messages[0].content[0] },
    (k, v) => (k === 'cache_control' ? undefined : v),
  );

/** Every marker in render order (tools → system → messages) with its effective ttl (omitted = 5m). */
const markersInOrder = (b: Body): string[] => {
  const out: string[] = [];
  const visit = (x: any) => x?.cache_control && out.push(x.cache_control.ttl ?? '5m');
  (b.tools ?? []).forEach(visit);
  (b.system ?? []).forEach(visit);
  for (const m of b.messages ?? []) if (Array.isArray(m.content)) m.content.forEach(visit);
  return out;
};
const ttlOrderValid = (ms: string[]) => !ms.some((t, i) => t === '5m' && ms.slice(i + 1).includes('1h'));

describe('relocateSystemTailEnabled — polarity', () => {
  it('is OFF unless explicitly armed (quality-unproven authority-semantics change)', () => {
    expect(relocateSystemTailEnabled({})).toBe(false);
    expect(relocateSystemTailEnabled({ PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '0' })).toBe(false);
    expect(relocateSystemTailEnabled({ PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '1' })).toBe(true);
  });

  it('does not relocate by default through the buffer wrapper', () => {
    const b = startupBody('o1');
    const r = rewriteAnthropicCacheBody(Buffer.from(JSON.stringify(b)), { splitBoundary: true });
    const out = JSON.parse(r.body.toString('utf8'));
    expect(r.stats?.tailRelocated).toBeUndefined();
    expect(out.system).toHaveLength(4); // split only: billing, identity, stable, tail — tail still in system
    expect(out.messages[0].content).toHaveLength(2);
  });
});

describe('byte-equality — no byte of prompt content is lost, duplicated or reordered', () => {
  it('stable half + relocated tail (minus the declared wrapper) concatenate to the original system text', () => {
    const original = startupBody('o1');
    const originalMerged = original.system[2].text as string;
    const { out } = run(original);
    expect(out.system).toHaveLength(3); // billing, identity, stable half — tail left the system prefix
    const relocated = out.messages[0].content[1].text as string;
    expect(relocated.startsWith(RELOCATED_TAIL_OPEN)).toBe(true);
    expect(relocated.endsWith(RELOCATED_TAIL_CLOSE)).toBe(true);
    const tailText = relocated.slice(RELOCATED_TAIL_OPEN.length, relocated.length - RELOCATED_TAIL_CLOSE.length);
    expect(out.system[2].text + PSU_CACHE_BOUNDARY + tailText).toBe(originalMerged);
  });

  it('message 0 keeps its original blocks verbatim and in order; only one block is inserted', () => {
    const original = startupBody('o1');
    const { out } = run(original);
    const [b0, inserted, b1] = out.messages[0].content;
    expect(b0.text).toBe(original.messages[0].content[0].text);
    expect(inserted.text).toContain('owner-specific state for o1');
    expect(b1.text).toBe(original.messages[0].content[1].text); // the first prompt is still LAST
    // cache_control is NOT prompt content (and the policy legitimately upgrades client markers to
    // the extended ttl), so content identity is compared with markers stripped.
    const content = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v));
    expect(content(out.messages.slice(1))).toBe(content(original.messages.slice(1)));
    expect(content(out.tools)).toBe(content(original.tools));
    expect(content(out.system.slice(0, 2))).toBe(content(original.system.slice(0, 2)));
  });
});

describe('prefix identity — the whole point', () => {
  const owners = ['o1', 'o2', 'o3', 'o4', 'o5'];

  it('CONTROL: without relocation the prefix through msg0 block 0 is owner-unique (the measured obstacle)', () => {
    const prefixes = new Set(owners.map((o) => prefixThroughBlock0(run(startupBody(o), false).out)));
    expect(prefixes.size).toBe(owners.length);
  });

  it('with relocation the prefix through msg0 block 0 is byte-identical across N same-form owners', () => {
    const prefixes = new Set(owners.map((o) => prefixThroughBlock0(run(startupBody(o)).out)));
    expect(prefixes.size).toBe(1);
  });

  it('owner-unique content appears ONLY after the shared block (nothing owner-specific precedes it)', () => {
    const { out } = run(startupBody('o3'));
    expect(prefixThroughBlock0(out)).not.toContain('o3');
    expect(JSON.stringify(out.messages[0].content.slice(1))).toContain('o3');
  });

  it('a different tools array still fragments the cohort — sharing is same-form AND same-tools only', () => {
    const a = prefixThroughBlock0(run(startupBody('o1', { tools: ['a', 'b'] })).out);
    const b = prefixThroughBlock0(run(startupBody('o2', { tools: ['a', 'b', 'c'] })).out);
    expect(a).not.toBe(b);
  });
});

describe('R1 — relocation is stateless: it never depends on turn number or breakpoint budget', () => {
  it('turn 1 and turn 6 of one owner lay out the prefix identically', () => {
    const t1 = run(startupBody('o1')).out;
    const t6 = run(startupBody('o1', { extraMessages: 5 })).out;
    const lay = (b: Body) => JSON.stringify({ s: b.system, m0: b.messages[0].content }, (k, v) => (k === 'cache_control' ? undefined : v));
    expect(lay(t6)).toBe(lay(t1));
  });

  it('relocates even when the 4-marker budget is exhausted — only the breakpoint ADD is budget-gated', () => {
    // A turn-4 body already carries exactly the client's 4 markers (identity, stable persona,
    // msg0's first prompt, the latest user turn) — no slot is left for the anchor.
    const b = startupBody('o1', { extraMessages: 3 });
    expect(markersInOrder(b)).toHaveLength(ANTHROPIC_MAX_BREAKPOINTS);
    const full = run(b);
    expect(full.stats?.tailRelocated).toBe(true);
    expect(full.out.system).toHaveLength(3);
    expect(full.stats?.tailBreakpoint).toBe('skipped-budget');
    expect(markersInOrder(full.out).length).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS);
    // …and the layout equals the roomy-budget turn-1 layout, so no cache cliff at the transition.
    const roomy = run(startupBody('o1')).out;
    const lay = (x: Body) => JSON.stringify({ s: x.system, m0: x.messages[0].content }, (k, v) => (k === 'cache_control' ? undefined : v));
    expect(lay(full.out)).toBe(lay(roomy));
  });
});

describe('breakpoint on the shared block', () => {
  it('adds an ephemeral marker on msg0 block 0 and stays within the 4-marker cap with monotone ttls', () => {
    const { out, stats } = run(startupBody('o1'));
    expect(stats?.tailRelocated).toBe(true);
    expect(stats?.tailBreakpoint).toBe('added');
    expect(out.messages[0].content[0].cache_control?.type).toBe('ephemeral');
    const ms = markersInOrder(out);
    expect(ms.length).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS);
    expect(ttlOrderValid(ms)).toBe(true);
  });

  it('leaves a client-set marker on the anchor alone', () => {
    const b = startupBody('o1');
    b.messages[0].content[0].cache_control = eph('5m');
    const { out, stats } = run(b);
    expect(stats?.tailBreakpoint).toBe('existing');
    expect(out.messages[0].content[0].cache_control).toEqual(eph('5m'));
  });

  it('inherits the short ttl after an earlier explicit short marker, keeping ttl order valid', () => {
    const b = startupBody('o1');
    b.system[1].cache_control = eph('5m'); // an earlier explicit short marker
    b.system[2].cache_control = eph('5m');
    b.messages[0].content[1].cache_control = eph('5m');
    const { out, stats } = run(b);
    expect(stats?.tailBreakpoint).toBe('added');
    expect(out.messages[0].content[0].cache_control.ttl).toBe('5m');
    expect(ttlOrderValid(markersInOrder(out))).toBe(true);
  });

  it('adds NO marker when it would sit short-before-long (defensive: needs an already-invalid client body)', () => {
    const b = startupBody('o1');
    b.system[1].cache_control = eph('5m'); // earlier explicit short…
    b.messages[0].content[1].cache_control = eph('1h'); // …LATER explicit long: client intent wins, we never rewrite it
    const { out, stats } = run(b);
    expect(stats?.tailBreakpoint).toBe('skipped-ttl-order');
    expect(out.messages[0].content[0].cache_control).toBeUndefined();
    expect(stats?.tailRelocated).toBe(true); // the move itself is stateless (R1) and still happens
  });
});

describe('fails toward no-op — the body is untouched when it cannot be done safely', () => {
  const mk = () => startupBody('o1');
  const split = (b: Body) => {
    const r = rewriteAnthropicCacheBody(Buffer.from(JSON.stringify(b)), { splitBoundary: true, relocateSystemTail: false });
    return JSON.parse(r.body.toString('utf8')) as Body; // system now has the tail at index 3
  };

  it.each([
    ['tail is not the last system block', (b: Body) => b.system.push({ type: 'text', text: 'late block' }), 'tail-not-last-system-block'],
    ['message 0 content is a string', (b: Body) => (b.messages[0].content = 'plain string'), 'first-message-not-user-array'],
    ['message 0 is an assistant turn', (b: Body) => (b.messages[0].role = 'assistant'), 'first-message-not-user-array'],
    ['the anchor block is not text', (b: Body) => (b.messages[0].content[0] = { type: 'image', source: {} }), 'anchor-not-text'],
    ['there are no messages', (b: Body) => (b.messages = []), 'no-messages'],
    ['the tail is whitespace only', (b: Body) => (b.system[3].text = '  \n'), 'tail-empty'],
    ['the tail block carries its own marker', (b: Body) => (b.system[3].cache_control = eph()), 'tail-carries-marker'],
  ])('%s', (_label, mutate, reason) => {
    const b = split(mk());
    mutate(b);
    const before = JSON.stringify(b);
    const r = relocateSystemTailToFirstUserTurn(b, 3);
    expect(r.relocated).toBe(false);
    expect(r.reason).toBe(reason);
    expect(JSON.stringify(b)).toBe(before); // not even a partial mutation
  });

  it('a body with no sentinel is never relocated (no split → no tail block exists)', () => {
    const b = mk();
    b.system[2].text = STABLE_PERSONA + tailFor('o1'); // no boundary → no split → no tail → nothing to relocate
    const input = Buffer.from(JSON.stringify(b));
    const r = rewriteAnthropicCacheBody(input, { splitBoundary: true, relocateSystemTail: true });
    expect(r.stats?.tailRelocated).toBeUndefined();
    expect(JSON.parse(r.body.toString('utf8')).messages[0].content).toHaveLength(2);
  });

  it('is idempotent: a second pass over its own output moves nothing more', () => {
    const once = run(startupBody('o1')).out;
    const twice = run(once).out;
    expect(JSON.stringify(twice.system)).toBe(JSON.stringify(once.system));
    expect(twice.messages[0].content).toHaveLength(3);
  });
});
