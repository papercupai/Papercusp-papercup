import { describe, it, expect } from 'vitest';
import { autoFixMdxAngles, blankFrontmatter, findFrontmatterYamlError, findMdxCompileError } from './mdx';

describe('blankFrontmatter', () => {
  it('returns the text unchanged when there is no leading frontmatter fence', () => {
    const text = '# Title\n\nsome prose\n';
    expect(blankFrontmatter(text)).toBe(text);
  });

  it('does not treat a `---` that is not on the first line as frontmatter', () => {
    // A horizontal rule mid-document must NOT be blanked.
    const text = 'intro line\n---\nafter the rule\n';
    expect(blankFrontmatter(text)).toBe(text);
  });

  it('blanks a valid frontmatter block to empty lines and preserves the body + line count', () => {
    const text = '---\ntitle: Hi\nslug: hi\n---\n# Body\n\ntext\n';
    const out = blankFrontmatter(text);
    // Same number of lines (blanked, not removed) — so compile errors still
    // point at the right source line.
    expect(out.split('\n').length).toBe(text.split('\n').length);
    // The four frontmatter lines (--- title slug ---) are now empty.
    const outLines = out.split('\n');
    expect(outLines.slice(0, 4)).toEqual(['', '', '', '']);
    // The body is untouched.
    expect(out).toContain('# Body');
    expect(out).toContain('text');
    expect(out).not.toContain('title: Hi');
  });

  it('leaves an unterminated frontmatter fence intact (lets the compiler report it)', () => {
    const text = '---\ntitle: Hi\nno closing fence\nstill going\n';
    expect(blankFrontmatter(text)).toBe(text);
  });

  it('blanks a minimal empty frontmatter block (--- immediately followed by ---)', () => {
    const text = '---\n---\nbody\n';
    const out = blankFrontmatter(text);
    expect(out.split('\n')).toEqual(['', '', 'body', '']);
  });
});

describe('findMdxCompileError', () => {
  it('rejects the Azure plan field list as an unbound runtime expression', async () => {
    const err = await findMdxCompileError('azure.mdx', 'An optional plan {publisher, product, name}.\n');
    expect(err?.reason).toContain('publisher');
    expect(err?.reason).toContain('backticks');
  });

  it.each(['{publisher}', '{publisher.name}', '{({publisher})}', '<div title={publisher} />'])(
    'rejects unbound identifiers in %s', async (expression) => {
      expect((await findMdxCompileError('unbound.mdx', expression))?.reason).toContain('publisher');
    },
  );

  it.each([
    'An optional plan `{publisher, product, name}`.\n',
    '```js\nconst plan = {publisher, product, name};\n```\n',
    'An optional plan \\{publisher, product, name\\}.\n',
    'export const publisher = "Azure"\n\n{publisher}\n',
    'import publisher from "./publisher.js"\n\n{publisher}\n',
    '{["Azure"].map((publisher) => publisher.toUpperCase()).join(", ")}\n',
    '{JSON.stringify({publisher: "Azure"})}\n',
    '{props.publisher}\n',
    '<Card title="Azure" />\n',
    '{typeof window === "undefined" ? "server" : "browser"}\n',
  ])('accepts literal examples and valid scoped MDX: %s', async (text) => {
    expect(await findMdxCompileError('valid.mdx', text)).toBeNull();
  });

  it('returns null for plain valid markdown/MDX', async () => {
    const err = await findMdxCompileError('ok.mdx', '# Hello\n\nSome **bold** and a [link](https://x).\n');
    expect(err).toBeNull();
  });

  it('returns null when valid content carries YAML frontmatter (frontmatter is blanked first)', async () => {
    const text = '---\ntitle: Doc\n---\n# Heading\n\nclean prose\n';
    const err = await findMdxCompileError('fm.mdx', text);
    expect(err).toBeNull();
  });

  it('returns null for GFM syntax (remark-gfm is wired into the pipeline)', async () => {
    const table = '# T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~struck~~\n';
    const err = await findMdxCompileError('gfm.mdx', table);
    expect(err).toBeNull();
  });

  it('reports a syntax error for a bare angle-bracket token written in prose', async () => {
    // `<date>` outside a code span is parsed as a JSX open tag with no close —
    // a hard MDX/astro build failure. This is the exact EI-438 case.
    const text = '# Heading\n\nUse the <date> placeholder here.\n';
    const err = await findMdxCompileError('bad.mdx', text);
    expect(err).not.toBeNull();
    expect(typeof err!.reason).toBe('string');
    expect(err!.reason.length).toBeGreaterThan(0);
    // reason is a single line (the detector splits on the first newline).
    expect(err!.reason).not.toContain('\n');
    // line/col are either a positive number or null — never NaN/undefined.
    expect(err!.line === null || (typeof err!.line === 'number' && err!.line >= 1)).toBe(true);
    expect(err!.col === null || (typeof err!.col === 'number' && err!.col >= 1)).toBe(true);
  });

  it('does NOT flag a bare angle-bracket token when it is inside a code span', async () => {
    // The same `<date>` token, but in an inline code span, compiles cleanly —
    // proving detection is the real compiler, not a regex (zero false positive).
    const err = await findMdxCompileError('codespan.mdx', 'Use the `<date>` placeholder.\n');
    expect(err).toBeNull();
  });

  it('flags a broken YAML frontmatter (EI-1449) even though the body compiles', async () => {
    // The body is clean; only the frontmatter is broken (an unquoted description
    // with a `": "` substring → YAML "bad indentation of a mapping entry"). The
    // body-only compile blanks the frontmatter and would miss it; the combined
    // detector must catch it because `astro build` parses frontmatter first.
    const text = '---\ntitle: Doc\ndescription: the action-layer "decision ledger": the meat\n---\n# Body\n\nclean prose\n';
    const err = await findMdxCompileError('brokenfm.mdx', text);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('frontmatter YAML');
    // Points at the offending frontmatter source line (the description, line 3).
    expect(err!.line).toBe(3);
  });
});

describe('findFrontmatterYamlError', () => {
  it('returns null when there is no leading frontmatter block', async () => {
    expect(await findFrontmatterYamlError('# Title\n\nprose\n')).toBeNull();
  });

  it('returns null for a valid frontmatter block', async () => {
    const text = '---\ntitle: Doc\ntags: [a, b]\nstatus: active\n---\n# Body\n';
    expect(await findFrontmatterYamlError(text)).toBeNull();
  });

  it('returns null when a `": "`-bearing value is properly single/double-quoted', async () => {
    // The canonical FIX for the EI-1449 break: quote the value. Must NOT flag.
    const text = '---\ntitle: Doc\ndescription: "the ledger\': the meat"\n---\n# Body\n';
    expect(await findFrontmatterYamlError(text)).toBeNull();
  });

  it('flags an unquoted value containing `": "` (the EI-1449 fleet-wide build-breaker)', async () => {
    const text = '---\ntitle: Doc\ndescription: the action-layer "decision ledger": the meat\n---\n# Body\n';
    const err = await findFrontmatterYamlError(text);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('frontmatter YAML');
    expect(err!.reason).not.toContain('\n'); // single-line reason
    expect(err!.line).toBe(3); // mapped to the real source line (1-based)
  });

  it('returns null for an unterminated fence (the MDX compile path reports that)', async () => {
    const text = '---\ntitle: Doc\nno closing fence\nstill going\n';
    expect(await findFrontmatterYamlError(text)).toBeNull();
  });
});

describe('autoFixMdxAngles (WI-276 — deterministic safe repair of `<`+digit and bare `<word>`)', () => {
  it('escapes a bare `<`+digit in prose (the exact 5-tick-block offender) and the result compiles', async () => {
    const text = '# Doc\n\nthe send lands in <1s in a good window.\n';
    const { fixed, changed } = autoFixMdxAngles(text);
    expect(changed).toBe(true);
    expect(fixed).toContain('lands in \\<1s in a good');
    expect(await findMdxCompileError('x.mdx', fixed)).toBeNull(); // round-trip: now valid
  });

  it('handles multiple + multiline `<`+digit', () => {
    const { fixed } = autoFixMdxAngles('respond in <5ms\nor <100ms under load\n');
    expect(fixed).toBe('respond in \\<5ms\nor \\<100ms under load\n');
  });

  it('leaves inline-code spans untouched (`<1s` is literal there)', () => {
    const text = 'use `<1s` as the budget\n';
    expect(autoFixMdxAngles(text)).toEqual({ fixed: text, changed: false });
  });

  it('leaves fenced code blocks untouched', () => {
    const text = '```bash\nif [ $x -lt <1 ]; then :; fi\n```\n';
    expect(autoFixMdxAngles(text).changed).toBe(false);
  });

  it('leaves frontmatter untouched (`<1s` there is a YAML string, not MDX)', () => {
    const text = '---\ndescription: "responds in <1s"\n---\n# Body\n';
    expect(autoFixMdxAngles(text).changed).toBe(false);
  });

  it('is idempotent — never double-escapes an already-escaped `\\<1`', () => {
    const once = autoFixMdxAngles('lands in <1s\n').fixed;
    expect(autoFixMdxAngles(once)).toEqual({ fixed: once, changed: false });
  });

  // WI-276 branch (2): the bare lowercase-`<word>` placeholder offender.
  it('escapes a bare lowercase placeholder `<slug>`/`<date>` in prose and the result compiles', async () => {
    const text = '# Doc\n\nName the file `<slug>.md`; use the <date> placeholder and an <id> value.\n';
    const { fixed, changed } = autoFixMdxAngles(text);
    expect(changed).toBe(true);
    expect(fixed).toContain('use the \\<date> placeholder and an \\<id> value');
    expect(fixed).toContain('`<slug>.md`'); // inline-code `<slug>` stays literal
    expect(await findMdxCompileError('x.mdx', fixed)).toBeNull(); // round-trip: now valid
  });

  it('escapes a hyphenated placeholder token `<my-flag>`', () => {
    const { fixed, changed } = autoFixMdxAngles('pass the <my-flag> option\n');
    expect(changed).toBe(true);
    expect(fixed).toBe('pass the \\<my-flag> option\n');
  });

  it('does NOT touch a Capitalized component tag (`<Card>`, `<Steps>` — left to the LLM fixer)', () => {
    const text = 'a `<Card>` and a bare <Steps> stay as-is\n';
    expect(autoFixMdxAngles(text).changed).toBe(false);
  });

  it('does NOT touch a real lowercase HTML/SVG tag (`<br>`, `<kbd>`, `<div>`, `<path>`)', () => {
    const text = 'press <kbd> keys, a <br> break, a <div> and an svg <path> element\n';
    expect(autoFixMdxAngles(text).changed).toBe(false);
  });

  it('does NOT touch a PROPERLY PAIRED unknown element (`<foo>…</foo>` compiles, so leave it)', async () => {
    const text = 'a paired <foo>value</foo> element stays\n';
    expect(autoFixMdxAngles(text).changed).toBe(false);
    // and it genuinely compiles (undefined lowercase element with a matching close)
    expect(await findMdxCompileError('x.mdx', text)).toBeNull();
  });

  it('does NOT touch a tag with attributes or a self-closing tag (`<name x=…>`, `<name/>`)', () => {
    const text = 'an <input type="text"> and a self-closing <line/> stay as-is\n';
    expect(autoFixMdxAngles(text).changed).toBe(false);
  });

  it('is idempotent on the `<word>` branch too', () => {
    const once = autoFixMdxAngles('the <slug> token\n').fixed;
    expect(once).toBe('the \\<slug> token\n');
    expect(autoFixMdxAngles(once)).toEqual({ fixed: once, changed: false });
  });
});

describe('findMdxCompileError — GFM-dependent parses (EI-22415725782521670)', () => {
  // The real fleet-wide break: a table cell whose inline code span contains
  // backslash-escaped backticks. With the GFM table extension the row parses;
  // without it the span leaks into the NEXT line, whose `<Component>` is then
  // read as an unclosed JSX tag. `astro build` resolved the no-gfm pipeline and
  // died with "Expected a closing tag for `<ArchitectChat>`", while this
  // detector — compiling WITH gfm — reported the doc clean. Both compiles now
  // run, so content that parses only one way is rejected as the latent
  // fleet-wide build break it is.
  const gfmDependent =
    '| Surface | What it does |\n' +
    '|---|---|\n' +
    '| **Brainstorm** | Can emit `\\`\\`\\`promote:spec\\`\\`\\`` action blocks. |\n' +
    '| **Architect** | Embedded via `<ArchitectInbox><ArchitectChat>` in the panel. |\n';

  it('REJECTS a doc that parses only when the GFM table extension is active', async () => {
    const err = await findMdxCompileError('system/lifecycle.mdx', gfmDependent);
    expect(err).not.toBeNull();
    // It must explain WHY, or the reader sees a parse error on a doc astro
    // currently builds fine and concludes the guard is broken.
    expect(err?.reason).toMatch(/GFM table extension/);
    expect(err?.reason).toMatch(/EI-22415725782521670/);
  });

  it('positive control: the same table WITHOUT the escaped backticks stays clean', async () => {
    // Proves the rejection above is caused by the escaped-backtick construct and
    // not merely by "a table containing a JSX-looking code span" — otherwise the
    // guard would be indistinguishable from one that rejects every such table.
    const repaired = gfmDependent.replace('`\\`\\`\\`promote:spec\\`\\`\\``', '`promote:spec`');
    expect(await findMdxCompileError('system/lifecycle.mdx', repaired)).toBeNull();
  });

  it('still accepts ordinary GFM tables and ordinary prose', async () => {
    const ordinary = '# Title\n\n| a | b |\n|---|---|\n| `code` | text |\n\nProse with `<Component>` in a span.\n';
    expect(await findMdxCompileError('x.mdx', ordinary)).toBeNull();
  });

  it('still reports a plain unclosed-JSX error (the pre-existing contract)', async () => {
    const err = await findMdxCompileError('x.mdx', '# x\n\nA bare <date> token in prose.\n');
    expect(err?.reason).toMatch(/Expected a closing tag/);
    // A plain parse error must NOT be dressed up in the gfm explanation.
    expect(err?.reason).not.toMatch(/GFM table extension/);
  });
});
