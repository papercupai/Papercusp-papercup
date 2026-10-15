/**
 * Tests for the MDX→markdown render pipeline (render-mdx.ts) which drives the
 * JSX-conversion plugin (remark-mdx-to-markdown.ts): Callout→blockquote,
 * Tabs/Steps/Card unwrap, unknown-JSX unwrap, self-closing drop, + the preamble.
 * Run with: npx vitest run packages/docs-engine/src/render-mdx.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { raceWithAbort, renderMdxToMarkdown, renderMdxToMarkdownUnqueued, setMdxRenderObserver, withPreamble, type MdxRenderObserver } from './render-mdx';

afterEach(() => { setMdxRenderObserver(undefined); vi.restoreAllMocks(); });

describe('MDX primary outcome observations', () => {
  it('records malformed parses and primary recovery, excluding queued cancellation', async () => {
    const sink = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setMdxRenderObserver(sink);
    expect(await renderMdxToMarkdown('Broken <owner> placeholder', '/docs/broken.mdx')).toContain('placeholder');
    expect(await renderMdxToMarkdown('# Recovered', '/docs/recovered.mdx')).toContain('Recovered');
    const controller = new AbortController();
    controller.abort();
    await expect(renderMdxToMarkdown('# Cancelled', '/docs/cancelled.mdx', controller.signal)).rejects.toThrow('cancelled');
    expect(sink.mock.calls).toEqual([
      ['mdx-render', { eligible: 1, applied: 0, reason: 'parse-failed' }],
      ['mdx-render', { eligible: 1, applied: 1, reason: 'applied' }],
    ]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('preserves both primary output and searchable fallback when the observer throws', async () => {
    const sink = vi.fn<MdxRenderObserver>(() => { throw new Error('storage unavailable'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setMdxRenderObserver(sink);
    expect(await renderMdxToMarkdown('# Primary', '/docs/primary.mdx')).toContain('Primary');
    expect(await renderMdxToMarkdown('Broken <owner> prose', '/docs/fallback.mdx')).toContain('prose');
    expect(sink.mock.calls.map(call => call[1].applied)).toEqual([1, 0]);
  });
});

const render = (mdx: string) => renderMdxToMarkdown(mdx, '/docs/test.mdx');

/**
 * Fan out `n` renders the way corpus callers do (Promise.all) while a self-rescheduling
 * setImmediate pump counts event-loop iterations. Returns the pump count observed as each
 * render resolved. One distinct value means the whole batch finished inside a single
 * microtask chain, with no loop turn in between. That is the starvation WI-10004766 measured.
 */
async function loopTicksAtEachResolution(
  renderFn: (mdx: string, path: string) => Promise<string>,
  n: number,
): Promise<number[]> {
  let ticks = 0;
  let stop = false;
  const pump = (): void => {
    ticks += 1;
    if (!stop) setImmediate(pump);
  };
  setImmediate(pump);
  const doc = '# Title\n\nSome **bold** prose with a [link](https://example.com) and `code`.\n\n- a\n- b\n';
  const seen = await Promise.all(
    Array.from({ length: n }, (_, i) => renderFn(doc, `/docs/batch-${i}.mdx`).then(() => ticks)),
  );
  stop = true;
  return seen;
}

describe('renderMdxToMarkdown — WI-10004766 a corpus batch must not starve the event loop', () => {
  it('CONTROL: the unqueued render resolves a whole Promise.all batch without one loop turn', async () => {
    // Calibrates the instrument: if this ever yields >1 distinct value, the probe below
    // could pass vacuously, so the queued assertion would prove nothing.
    const seen = await loopTicksAtEachResolution(renderMdxToMarkdownUnqueued, 12);
    expect(new Set(seen).size).toBe(1);
  });

  it('the queued render gives the event loop a turn between every page', async () => {
    const seen = await loopTicksAtEachResolution(renderMdxToMarkdown, 12);
    expect(new Set(seen).size).toBe(12);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
  });

  it('keeps per-call results and order under a concurrent batch', async () => {
    const out = await Promise.all(['# A', '# B', '# C'].map((m) => render(m)));
    expect(out.map((s) => s.trim())).toEqual(['# A', '# B', '# C']);
  });

  it('a malformed doc mid-batch neither rejects nor stalls the pages queued behind it', async () => {
    const out = await Promise.all([render('# one'), render('broken <owner> placeholder'), render('# three')]);
    expect(out[0]!.trim()).toBe('# one');
    expect(out[1]).toContain('placeholder');
    expect(out[2]!.trim()).toBe('# three');
  });

  it('does not start an MDX parse that was still queued when its signal aborted', async () => {
    const active = renderMdxToMarkdown('# active', '/docs/active.mdx');
    const controller = new AbortController();
    const queued = renderMdxToMarkdown('# queued', '/docs/queued.mdx', controller.signal);
    controller.abort();

    await expect(active).resolves.toContain('# active');
    await expect(queued).rejects.toThrow('cancelled');
  });

  it('lets one caller stop waiting without cancelling shared work for other readers', async () => {
    let complete!: (value: string) => void;
    const shared = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const controller = new AbortController();
    const caller = raceWithAbort(shared, controller.signal);

    controller.abort();
    await expect(caller).rejects.toThrow('cancelled');
    complete('shared result');
    await expect(shared).resolves.toBe('shared result');
  });
});

describe('renderMdxToMarkdown — Callout → blockquote', () => {
  it('maps a typed Callout to a titled blockquote', async () => {
    const out = await render('<Callout type="warning">\nBe careful here.\n</Callout>\n');
    expect(out).toContain('**Warning:');
    expect(out).toContain('Be careful here.');
    expect(out).toMatch(/^>/m); // blockquote marker
    expect(out).not.toContain('<Callout');
  });

  it('maps each known type to its title word', async () => {
    expect(await render('<Callout type="error">x</Callout>\n')).toContain('**Error:');
    expect(await render('<Callout type="danger">x</Callout>\n')).toContain('**Error:');
    expect(await render('<Callout type="info">x</Callout>\n')).toContain('**Note:');
    expect(await render('<Callout type="success">x</Callout>\n')).toContain('**Tip:');
  });

  it('prefers an explicit title attribute', async () => {
    expect(await render('<Callout title="Heads up">x</Callout>\n')).toContain('**Heads up:');
  });

  it('defaults to Note when no type/title is given', async () => {
    expect(await render('<Callout>x</Callout>\n')).toContain('**Note:');
  });

  it('reads a JSX-expression attribute value (strips quotes)', async () => {
    // type={"warning"} → mdxJsxAttributeValueExpression → getAttr strips the quotes.
    expect(await render('<Callout type={"warning"}>x</Callout>\n')).toContain('**Warning:');
  });
});

describe('renderMdxToMarkdown — unwrapping', () => {
  it('unwraps layout components (Tabs/Steps/Card), keeping their children', async () => {
    const out = await render('<Tabs>\n\nInner tab content.\n\n</Tabs>\n');
    expect(out).toContain('Inner tab content.');
    expect(out).not.toContain('<Tabs');
    expect(out).not.toContain('Tabs>');
  });

  it('unwraps an unknown JSX element rather than emitting a literal tag', async () => {
    const out = await render('<Mystery>\n\nkept body\n\n</Mystery>\n');
    expect(out).toContain('kept body');
    expect(out).not.toContain('<Mystery');
  });

  it('drops a self-closing unknown JSX element entirely', async () => {
    const out = await render('Before.\n\n<Widget />\n\nAfter.\n');
    expect(out).toContain('Before.');
    expect(out).toContain('After.');
    expect(out).not.toContain('Widget');
  });

  it('leaves ordinary markdown + GFM untouched', async () => {
    const out = await render('# Heading\n\n- a\n- b\n');
    expect(out).toContain('# Heading');
    expect(out).toContain('* a'); // remark-stringify normalizes list bullets
  });
});

describe('renderMdxToMarkdown — EI-5860 resilience (a malformed doc must not throw / blind the corpus)', () => {
  it('does not throw on a raw <lowercase> placeholder (unclosed JSX tag); keeps prose searchable', async () => {
    // The real EI-5860 repro: a `<owner>` placeholder in prose parses as an
    // unclosed JSX tag → "Expected a closing tag for `<owner>`". Must degrade, not throw.
    const mdx = 'Resume via ~/.papercusp/session-claude/<owner>/projects keyed by the owner id.\n';
    const out = await render(mdx);
    expect(out).toContain('session-claude');
    expect(out).toContain('projects');
  });

  it('does not throw on an unparseable {expression} (acorn); keeps prose searchable', async () => {
    // `{not valid js}` → "Could not parse expression with acorn". Must degrade, not throw.
    const out = await render('Set the value {not valid js here} and continue inline.\n');
    expect(out).toContain('continue inline');
  });

  it('fallback strips a leading frontmatter block + ESM import/export lines, keeping prose', async () => {
    const mdx =
      ['---', 'title: Broken doc', '---', "import Foo from './foo';", '', 'The <owner> placeholder fails to parse but the prose survives.'].join(
        '\n',
      ) + '\n';
    const out = await render(mdx);
    expect(out).not.toContain('title: Broken doc'); // frontmatter stripped
    expect(out).not.toMatch(/^import /m); // import wiring stripped
    expect(out).toContain('prose survives'); // prose kept → keyword-searchable
  });

  it('EI-5861: a bare <owner> in the frontmatter description of a whole-raw doc must not throw', async () => {
    // The EI-5861 repro: docs:search threw workspace-wide with
    // "Expected a closing tag for `<owner>` (3:103)" — a frontmatter `description:`
    // holding a bare `<owner>`. The generic-fs adapter renders the WHOLE raw doc
    // (frontmatter NOT pre-stripped), so remark-mdx parses that description line as
    // a paragraph with an unclosed JSX tag. Must degrade to the raw-text fallback,
    // not throw and blind the whole corpus for search/outline.
    const mdx =
      [
        '---',
        'title: Owner cursor',
        'description: Resume the session keyed by the coordination <owner> id so the fleet can find the transcript later on',
        '---',
        '',
        '# Owner cursor',
        '',
        'The coordination cursor lives in a per-owner file the fleet reads.',
      ].join('\n') + '\n';
    const out = await render(mdx);
    expect(out).not.toContain('description:'); // frontmatter (with the bad tag) stripped by the fallback
    expect(out).toContain('per-owner file'); // body prose kept → keyword-searchable
  });
});

describe('withPreamble', () => {
  it('prepends the title / URL / description block', () => {
    expect(withPreamble('BODY', { title: 'T', url: 'https://x/y', description: 'D' })).toBe(
      '# T\nURL: https://x/y\n\nD\n\nBODY',
    );
  });

  it('renders an empty description line when none is supplied', () => {
    expect(withPreamble('BODY', { title: 'T', url: 'U' })).toBe('# T\nURL: U\n\n\n\nBODY');
  });
});
