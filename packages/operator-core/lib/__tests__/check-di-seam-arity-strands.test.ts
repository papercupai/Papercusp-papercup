/**
 * EI-19448665215423873 — a DI seam whose call ARITY is narrower than the production
 * default it replaces silently makes a property untestable without failing any test.
 * Pins the fixed live instance (`inference-gateway/gateway.ts`'s `governorFor`, which
 * used to drop `accountId`) as a regression fixture: the guard must flag the pre-fix
 * shape and stay silent on the post-fix shape.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { findArityStrandsInSource } from '../../../../scripts/check-di-seam-arity-strands.mjs';

describe('findArityStrandsInSource', () => {
  it('flags a seam call that drops an identifier the default branch receives', () => {
    const src = `
      const g = deps.governorFor ? deps.governorFor(model)
                                  : governorForBackend('claude-code', model, undefined, accountId);
    `;
    const findings = findArityStrandsInSource(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].seam).toBe('deps.governorFor');
    expect(findings[0].missing).toEqual(['accountId']);
  });

  it('does NOT flag the fixed shape — the seam call now forwards every dropped identifier', () => {
    const src = `
      const g = deps.governorFor ? deps.governorFor(model, accountId)
                                  : governorForBackend('claude-code', model, undefined, accountId);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('ignores a literal `undefined` placeholder arg — it is not an in-scope value being dropped', () => {
    const src = `
      const x = deps.seam ? deps.seam(a) : real(a, undefined);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('ignores literal arguments on the default branch — they are not in-scope values', () => {
    const src = `
      const x = deps.seam ? deps.seam(a) : real(a, 'literal', 42);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  // WI-6554700010009845 — this test used to assert that a property-access argument was ignored
  // too. That was the blind spot that hid the agent-loop/anthropic-port.ts rawStream strand.
  it('reports a property-access argument on the default branch that the seam drops', () => {
    const src = `
      const x = deps.seam ? deps.seam(a) : real(a, 'literal', obj.prop, 42);
    `;
    expect(findArityStrandsInSource(src)).toEqual([
      expect.objectContaining({ seam: 'deps.seam', missing: ['obj.prop'] }),
    ]);
  });

  it('does not flag when the whenFalse branch is not a call on the tested property', () => {
    const src = `
      const x = deps.seam ? somethingElse(a, b) : real(a, b, c);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('does not flag a ternary whose condition is not a property access', () => {
    const src = `
      const x = flag ? doA(a, b) : doB(a, b, c);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });
});

/**
 * WI-6554700010009519 — the guard knew ONE spelling (un-awaited `X.s ? X.s(…) : d(…)`), so the
 * live dao-hr/onboarding.ts narrowing `await (deps.adminPerson?.() ?? resolveHiringActor(key, …))`
 * (4 sites) passed unseen while its ternary twin in engagement-changes.ts was flagged. The same
 * gap hid six more strands behind `await`ed branches. Each spelling below must be caught, and the
 * three measured false-positive shapes must stay silent.
 */
describe('findArityStrandsInSource — every spelling of "seam if present, else default"', () => {
  const missingOf = (src: string) =>
    findArityStrandsInSource(src).map((f: { missing: string[] }) => [...f.missing].sort());

  it('flags the optional-call nullish form — the onboarding.ts shape', () => {
    const findings = findArityStrandsInSource(`
      const actor = await (deps.adminPerson?.() ?? resolveHiringActor(key, { sql }));
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ seam: 'deps.adminPerson', form: 'nullish', missing: ['key'] });
  });

  it('reports every identifier the nullish seam drops', () => {
    expect(missingOf(`const x = deps.x?.() ?? dflt(a, b);`)).toEqual([['a', 'b']]);
  });

  it('flags the optional-call || form', () => {
    const findings = findArityStrandsInSource(`const x = deps.x?.(a) || dflt(a, b);`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ form: 'or', missing: ['b'] });
  });

  it('looks through await on both ternary branches', () => {
    expect(missingOf(`const t = deps.hasToolchain ? await deps.hasToolchain() : await probe(sourceRoot);`)).toEqual([
      ['sourceRoot'],
    ]);
  });

  it.each([
    ['!= null', `deps.x != null ? deps.x(a) : dflt(a, b)`],
    ['!== undefined', `deps.x !== undefined ? deps.x(a) : dflt(a, b)`],
    ['reversed operands', `undefined !== deps.x ? deps.x(a) : dflt(a, b)`],
    ["typeof === 'function'", `typeof deps.x === 'function' ? deps.x(a) : dflt(a, b)`],
    ['negated: !X.s', `!deps.x ? dflt(a, b) : deps.x(a)`],
    ['negated: === undefined', `deps.x === undefined ? dflt(a, b) : deps.x(a)`],
    ["negated: typeof !== 'function'", `typeof deps.x !== 'function' ? dflt(a, b) : deps.x(a)`],
  ])('recognises the %s condition and picks the seam branch from it', (_label, expr) => {
    expect(missingOf(`const v = ${expr};`)).toEqual([['b']]);
  });

  it('stays silent on the fixed onboarding shape — the seam forwards key', () => {
    expect(findArityStrandsInSource(`const a = await (deps.adminPerson?.(key) ?? resolveHiringActor(key, { sql }));`)).toEqual(
      [],
    );
  });

  it('does not treat a NON-optional call as a seam (`map.get(k) ?? build(k, ctx)` is a plain fallback)', () => {
    expect(findArityStrandsInSource(`const v = cache.get(k) ?? build(k, ctx);`)).toEqual([]);
  });

  it('does not flag `(deps.x ?? dflt)(…)` — both receive identical arguments by construction', () => {
    expect(findArityStrandsInSource(`const v = (deps.x ?? dflt)(a, b);`)).toEqual([]);
  });

  // WI-6554700010009741 — the statement spellings of the same substitution.
  const fn = (body: string) => `async function f(a, b) {\n${body}\n}`;

  it('flags the if-return form, and a negated condition that swaps the branches', () => {
    expect(missingOf(fn('if (deps.x) return deps.x(a);\nreturn dflt(a, b);'))).toEqual([['b']]);
    expect(missingOf(fn('if (!deps.x) return dflt(a, b);\nreturn deps.x(a);'))).toEqual([['b']]);
    expect(findArityStrandsInSource(fn('if (deps.x) return deps.x(a);\nreturn dflt(a, b);'))[0]).toMatchObject({
      form: 'if-return',
      seam: 'deps.x',
    });
  });

  it('flags the if-else form for return, bare-expression and same-target assignment branches', () => {
    expect(missingOf('if (deps.x) { r = deps.x(a); } else { r = dflt(a, b); }')).toEqual([['b']]);
    expect(missingOf('if (deps.x != null) deps.x(a); else dflt(a, b);')).toEqual([['b']]);
    expect(missingOf(fn("if (typeof deps.x === 'function') { return await deps.x(a); } else { return dflt(a, b); }"))).toEqual([
      ['b'],
    ]);
  });

  it('flags the pre-fix alarm-notify shape (release-actions.ts) and stays silent on the fixed one', () => {
    const pre = 'if (deps.alarm?.notify) await deps.alarm.notify({ title: input.title, body: input.body });\nelse await notifyAttention(input);';
    expect(findArityStrandsInSource(pre)).toEqual([
      expect.objectContaining({ form: 'if-else', seam: 'deps.alarm.notify', missing: ['input'] }),
    ]);
    expect(missingOf('if (deps.alarm?.notify) await deps.alarm.notify(input);\nelse await notifyAttention(input);')).toEqual([]);
  });

  it('stays silent on statement shapes that are not a substitution', () => {
    // A non-return then-branch with no else: the next statement runs either way.
    expect(missingOf(fn('if (deps.x) await deps.x(a);\nawait dflt(a, b);'))).toEqual([]);
    // Different assignment targets, or different payload kinds.
    expect(missingOf('if (deps.x) r = deps.x(a); else s = dflt(a, b);')).toEqual([]);
    expect(missingOf(fn('if (deps.x) return deps.x(a); else dflt(a, b);'))).toEqual([]);
    // A multi-statement branch is outside the recognised forms.
    expect(missingOf(fn('if (deps.x) { log(); return deps.x(a); }\nreturn dflt(a, b);'))).toEqual([]);
    // Two members of ONE receiver, and a seam that forwards everything.
    expect(missingOf('if (deps.x) deps.x(a); else deps.y(a, b);')).toEqual([]);
    expect(missingOf(fn('if (deps.x) return await deps.x(a, b);\nreturn dflt(a, b);'))).toEqual([]);
  });

  it("does not count the seam's own receiver as dropped, but still reports anything else", () => {
    expect(findArityStrandsInSource(`const m = opts.read ? await opts.read() : await dflt(opts);`)).toEqual([]);
    expect(missingOf(`const m = opts.read ? await opts.read() : await dflt(opts, ws);`)).toEqual([['ws']]);
  });

  it('does not flag a transaction wrapper that delegates to the default', () => {
    const src = `
      const a = typeof sql.begin === 'function' ? await sql.begin(run) : await run(sql);
      const b = typeof tx.savepoint === 'function' ? await tx.savepoint((sp) => run(sp)) : await run(tx);
      const c = typeof t.savepoint === 'function' ? await t.savepoint((x) => run(x as unknown as Sql)) : await run(sql);
    `;
    expect(findArityStrandsInSource(src)).toEqual([]);
  });

  it('does not flag two members of ONE receiver — the arities are its interface contract', () => {
    expect(findArityStrandsInSource(`const p = () => source.peek?.() ?? source.active(keyOf);`)).toEqual([]);
  });
});

/**
 * WI-6554700010009845 — the guard compared bare-identifier arguments only, so a seam that narrows an
 * OBJECT-LITERAL or property-access argument was invisible. The live instance was
 * agent-loop/anthropic-port.ts: its `rawStream` seam never received the route's priority, account
 * and ownerId. Every silent fixture is paired with a reporting one in the same syntactic form, so a
 * silent result cannot come from the form simply going unrecognised.
 */
describe('findArityStrandsInSource — object-literal and property-access arguments', () => {
  const missingOf = (src: string) =>
    findArityStrandsInSource(src).map((f: { missing: string[] }) => [...f.missing].sort());

  it('reports each name the default literal sets and the seam literal never does', () => {
    expect(
      missingOf('const r = deps.alarm ? deps.alarm({ title, body }) : notify({ kind, title, body, importance });'),
    ).toEqual([['{importance}', '{kind}']]);
  });

  it('stays silent when both literals set the same names', () => {
    expect(missingOf('const r = deps.alarm ? deps.alarm({ title, body }) : notify({ title, body });')).toEqual([]);
    expect(missingOf('const r = deps.alarm ? deps.alarm({ body, title: t }) : notify({ title: t, body });')).toEqual([]);
  });

  it('stays silent when the seam literal spreads another object, which may carry any name', () => {
    expect(missingOf('const r = deps.alarm ? deps.alarm({ ...base, title }) : notify({ kind, title, body });')).toEqual([]);
    expect(missingOf('const r = deps.alarm ? deps.alarm({ title }) : notify({ kind, title, body });')).toEqual([
      ['{body}', '{kind}'],
    ]);
  });

  it('reports a dropped property-access argument, matching `a?.b` to `a.b`', () => {
    expect(missingOf('const r = deps.send ? deps.send(req?.body) : send(req.body, req.priority);')).toEqual([
      ['req.priority'],
    ]);
    expect(missingOf('const r = deps.send ? deps.send(req.body, req.priority) : send(req.body, req.priority);')).toEqual(
      [],
    );
  });

  it('stays silent when the two literals share no name — two vocabularies, nothing to compare', () => {
    expect(missingOf('const r = deps.run ? deps.run({ input }) : dispatch({ priority, account, ownerId });')).toEqual([]);
    expect(
      missingOf('const r = deps.run ? deps.run({ input, priority }) : dispatch({ priority, account, ownerId });'),
    ).toEqual([['{account}', '{ownerId}']]);
  });

  it("stays silent on a value rooted at the seam's receiver — the receiver's supplier can close over it", () => {
    expect(missingOf('const m = opts.read ? await opts.read() : await dflt(opts.path, opts.encoding);')).toEqual([]);
    expect(missingOf('const m = opts.read ? await opts.read() : await dflt(opts.path, other.encoding);')).toEqual([
      ['other.encoding'],
    ]);
  });

  it('ignores a chain through a call or an element access — not an in-scope value', () => {
    expect(missingOf('const r = deps.query ? deps.query(a) : query(a, getOrgPg().sql, rows[0].id);')).toEqual([]);
    expect(missingOf('const r = deps.query ? deps.query(a) : query(a, pg.sql);')).toEqual([['pg.sql']]);
  });

  it('treats an identifier the seam passes as carrying every chain rooted at it', () => {
    expect(missingOf('const r = deps.read ? await deps.read({ call }) : await read(call.signal, call.id);')).toEqual([]);
    expect(missingOf('const r = deps.read ? await deps.read(call) : await read(call.signal);')).toEqual([]);
    expect(missingOf('const r = deps.read ? await deps.read({ other }) : await read(call.signal);')).toEqual([
      ['call.signal'],
    ]);
  });

  it('recognises the receiver behind an `as` cast', () => {
    expect(missingOf('const t = (r.last as Date).getTime ? (r.last as Date).getTime() : Date.parse(r.last);')).toEqual([]);
    expect(missingOf('const t = (r.last as Date).getTime ? (r.last as Date).getTime() : Date.parse(r.first);')).toEqual([
      ['r.first'],
    ]);
  });
});
