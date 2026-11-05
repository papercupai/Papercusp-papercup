/** Shared sanitizer used by the real bundle and the regression corpus. */
export function sanitizeReportMarkup(purify: { sanitize: (html: string, config: Record<string, unknown>) => string }, html: string, svg = false): string {
  return purify.sanitize(html, svg ? { USE_PROFILES: { svg: true, svgFilters: false }, SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ['foreignObject', 'script', 'image', 'a', 'use', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href'] }
    : { ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','hr','a','strong','em','del','s','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','sup','sub','details','summary'],
      ALLOWED_ATTR: ['href','title','class','align','colspan','rowspan'], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true });
}

/** Anonymous reader. No operator dependency, credential, storage, analytics or report index. */
export async function startReportViewer(doc: Document, deps: {
  markdown: (source: string) => string;
  sanitize: (html: string, svg?: boolean) => string;
  diagram: (source: string, id: string) => Promise<string>;
  fetch?: typeof fetch;
}): Promise<void> {
  const win = doc.defaultView!;
  const status = doc.getElementById('status')!;
  const article = doc.getElementById('report')!;
  const outline = doc.getElementById('outline')!;
  const fail = (message: string) => { status.textContent = message; status.setAttribute('role', 'alert'); };
  const params = new URLSearchParams(win.location.hash.slice(1));
  const gist = params.get('gist') || '';
  // The owner is part of the locator so we can use GitHub's CORS-enabled raw host
  // without spending the browser's small anonymous REST API quota.
  const match = /^([a-z\d](?:[a-z\d-]{0,38}))\/([a-f\d]{32})$/i.exec(gist);
  if (!match) { fail('This link is missing a valid shared report. Ask the sender for the complete link.'); return; }
  status.textContent = 'Loading shared report…';
  try {
    const request = deps.fetch ?? win.fetch.bind(win);
    // GitHub's raw CDN can serve a deleted Gist for five minutes, even when
    // fetch says no-store. A fresh cache key checks the provider on EVERY load.
    const readNonce = [...win.crypto.getRandomValues(new Uint32Array(4))].join('-');
    const response = await request('https://gist.githubusercontent.com/' + match[1] + '/' + match[2] + '/raw/report.md?read=' + readNonce, {
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      fail(response.status === 404 ? 'This report is unavailable or sharing has stopped.'
        : response.status === 429 || response.status === 403 ? 'GitHub is limiting requests. Try again later.'
        : 'GitHub could not load this report. Try again later.');
      return;
    }
    const target = new URL(response.url || 'https://gist.githubusercontent.com/');
    if (target.protocol !== 'https:' || target.hostname !== 'gist.githubusercontent.com') throw new Error('Unexpected response host');
    if (Number(response.headers.get('content-length')) > 524288) throw new Error('Report is too large');
    const source = await response.text();
    if (new TextEncoder().encode(source).length > 524288) throw new Error('Report is too large');
    article.innerHTML = deps.sanitize(deps.markdown(source));
    // Markdown images are deliberately omitted: opening an unlisted report must
    // not contact a tracking server chosen by its author.
    article.querySelectorAll('img,iframe,object,embed,form,style,base,meta').forEach(node => node.remove());
    article.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
      const raw = link.getAttribute('href') || '';
      if (raw.startsWith('#')) {
        link.addEventListener('click', event => {
          event.preventDefault();
          let id: string;
          try { id = decodeURIComponent(raw.slice(1)); } catch { return; }
          const node = doc.getElementById(id);
          if (node && article.contains(node)) node.scrollIntoView?.();
        });
      } else if (!/^(https?:|mailto:)/i.test(raw)) link.removeAttribute('href');
      else { link.rel = 'noopener noreferrer'; link.target = '_blank'; }
    });
    const headings = [...article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
    const seen = new Set<string>();
    outline.replaceChildren();
    headings.forEach((node, index) => {
      const slug = (node.textContent || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
      let id = 'section-' + slug;
      for (let suffix = 2; seen.has(id); suffix++) id = 'section-' + slug + '-' + suffix;
      seen.add(id); node.id = id; node.tabIndex = -1;
      const link = doc.createElement('a');
      link.textContent = node.textContent || 'Section ' + (index + 1);
      link.href = '#' + new URLSearchParams({ gist, section: id }).toString();
      link.style.paddingInlineStart = String(12 + (Number(node.tagName[1]) - 1) * 12) + 'px';
      link.addEventListener('click', event => {
        event.preventDefault();
        win.history.pushState(null, '', link.getAttribute('href'));
        node.scrollIntoView?.({ behavior: win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        node.focus({ preventScroll: true });
      });
      outline.append(link);
    });
    const navigate = () => {
      const id = new URLSearchParams(win.location.hash.slice(1)).get('section');
      if (id && seen.has(id)) doc.getElementById(id)?.scrollIntoView?.();
    };
    win.addEventListener('popstate', navigate); navigate();
    doc.title = headings[0]?.textContent || 'Shared report';
    article.querySelectorAll('table').forEach((table, i) => {
      const wrapper = doc.createElement('div'); wrapper.className = 'table-scroll';
      wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Report table ' + (i + 1));
      table.before(wrapper); wrapper.append(table);
    });
    let diagramIndex = 0;
    for (const code of article.querySelectorAll('pre > code.language-mermaid')) {
      const holder = doc.createElement('div'); holder.className = 'diagram';
      const text = code.textContent || '';
      try {
        // Config/frontmatter/click directives are not report content. Locking
        // configuration also prevents diagram text from weakening Mermaid policy.
        if (/%%\{|^\s*---|^\s*click\s/im.test(text)) throw new Error('Diagram directives are disabled');
        holder.innerHTML = deps.sanitize(await deps.diagram(text, 'diagram-' + diagramIndex++), true);
        holder.querySelectorAll('[href],[xlink\\:href]').forEach(node => {
          node.removeAttribute('href'); node.removeAttribute('xlink:href');
        });
        code.parentElement!.replaceWith(holder);
      } catch {
        const note = doc.createElement('p'); note.textContent = 'Diagram unavailable. Its source is shown below.';
        code.parentElement!.before(note);
      }
    }
    status.textContent = 'Shared snapshot · anyone with this link can read it. Saved copies cannot be recalled.';
    article.hidden = false;
  } catch {
    article.replaceChildren(); outline.replaceChildren();
    fail('Could not load this report. Check your connection and try again.');
  }
}
