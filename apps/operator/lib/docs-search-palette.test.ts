import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom is installed as Vitest's runtime, without @types/jsdom in this package.
// This test consumes only its standard DOM window, so keep that boundary typed.
type TestDom = { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: {
    url: string; runScripts: 'dangerously'; beforeParse(window: TestDom['window']): void;
  }) => TestDom;
};

// Execute the shipped standalone page, without a browser or Pagefind engine.
// Native keyboard ownership is exercised separately in the Tauri acceptance run.
const html = readFileSync(resolve(__dirname, '../../operator-docs/public/search-palette.html'), 'utf8');
const windows: TestDom[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

function palette(fetch: ReturnType<typeof vi.fn>) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:16582/internal/docs/search-palette.html',
    runScripts: 'dangerously',
    beforeParse(window) { window.fetch = fetch as typeof window.fetch; },
  });
  windows.push(dom);
  const input = dom.window.document.querySelector<HTMLInputElement>('#docs-query')!;
  function type(value: string) {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  return { dom, input, type, document: dom.window.document };
}

const hit = { title: 'Shortcut settings', url: '/internal/docs/guide/shortcuts', excerpt: 'Release the global accelerator.' };
const response = (hits = [hit]) => ({ ok: true, json: async () => ({ hitCount: hits.length, hits }) });

describe('the packaged docs keyword palette', () => {
  it('focuses search, displays real results and provides keyboard navigation', async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    const { dom, input, type, document } = palette(fetch);
    expect(document.activeElement).toBe(input);
    type('global accelerator');
    await vi.waitFor(() => expect(document.querySelector('a')?.textContent).toBe(hit.title));
    expect(fetch.mock.calls[0][0]).toBe('/internal/docs/search.json?q=global%20accelerator');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('http://127.0.0.1:16582/internal/docs/guide/shortcuts');
    expect(document.querySelector('.pagefind-ui__result-excerpt')?.textContent).toBe(hit.excerpt);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('a'));
    const click = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('a')!.addEventListener('click', click);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('keeps excerpts as text and refuses links outside the docs mount', async () => {
    const dangerous = { ...hit, title: '<img src=x onerror=alert(1)>', excerpt: '<script>leak()</script>' };
    const fetch = vi.fn().mockResolvedValue(response([
      dangerous, { ...hit, url: 'https://outside.example/internal/docs/private' },
      { ...hit, url: '/api/admin' }, { ...hit, url: 'javascript:alert(1)' },
    ]));
    const { type, document } = palette(fetch);
    type('accelerator');
    await vi.waitFor(() => expect(document.querySelector('a')?.textContent).toBe(dangerous.title));
    expect(document.querySelectorAll('a')).toHaveLength(1);
    expect(document.querySelector('#search img, #search script')).toBeNull();
    expect(document.querySelector('.pagefind-ui__result-excerpt')?.textContent).toBe(dangerous.excerpt);
  });

  it('ignores a stale response after a later query is cleared', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { type, document } = palette(fetch);
    type('accelerator');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    type('');
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    finish(response());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('#search-results')?.children).toHaveLength(0);
    expect(document.querySelector('#search-status')?.textContent).toBe('');
  });

  it('shows empty and failed searches explicitly', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce({ ok: false });
    const { type, document } = palette(fetch);
    type('missing');
    await vi.waitFor(() => expect(document.querySelector('#search-status')?.textContent).toBe('No results found.'));
    type('accelerator');
    await vi.waitFor(() => expect(document.querySelector('#search-status')?.textContent).toContain('unavailable'));
  });
});
