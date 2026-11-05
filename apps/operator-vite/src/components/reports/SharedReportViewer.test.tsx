// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import DOMPurify from 'dompurify';
import {marked} from 'marked';
import {sanitizeReportMarkup,startReportViewer} from '@papercusp/operator-core/lib/report-sharing-browser';
const gist='alice/'+'a'.repeat(32);
beforeEach(()=>{document.body.innerHTML='<p id="status"></p><article id="report" hidden></article><nav id="outline"></nav>';
  history.replaceState(null,'','#'+new URLSearchParams({gist}));HTMLElement.prototype.scrollIntoView=vi.fn();});
function render(source:string,status=200){
  const request=vi.fn(async()=>new Response(source,{status}));const diagram=vi.fn(async()=>'<svg><text>Safe chart</text><script>bad()</script><foreignObject>bad</foreignObject></svg>');
  const done=startReportViewer(document,{markdown:s=>marked.parse(s,{async:false}),sanitize:(html,svg)=>sanitizeReportMarkup(DOMPurify,html,svg),diagram,fetch:request as typeof fetch});
  return {done,request,diagram};
}
describe('anonymous shared reader',()=>{
  it('uses a fresh raw CDN cache key for each load so a deleted Gist cannot reuse an edge response',async()=>{
    const first=render('# Snapshot');await first.done;const second=render('# Snapshot');await second.done;
    const a=new URL(String(first.request.mock.calls[0]?.[0]));const b=new URL(String(second.request.mock.calls[0]?.[0]));
    expect(a.searchParams.get('read')).toBeTruthy();expect(a.searchParams.get('read')).not.toBe(b.searchParams.get('read'));
  });
  it('SHARE-READER renders headings, tables, fenced code and sanitized diagram output',async()=>{
    const f=render('# A report\n\n## Findings\n\n| A | B |\n|---|---|\n| yes | done |\n\n```js\nconst a = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```');await f.done;
    expect(document.querySelector('#report')?.getAttribute('hidden')).toBeNull();expect(document.querySelectorAll('table')).toHaveLength(1);
    expect(document.querySelector('.table-scroll')?.getAttribute('tabindex')).toBe('0');expect(document.querySelector('code.language-js')?.textContent).toContain('const a');
    expect(document.querySelector('.diagram svg')).toBeTruthy();expect(document.querySelector('script,foreignObject')).toBeNull();
    expect(f.request).toHaveBeenCalledWith(expect.stringContaining('gist.githubusercontent.com/alice/'),expect.objectContaining({credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}));
  });
  it('SHARE-SIDEBAR preserves the locator while navigating duplicate and Unicode headings',async()=>{
    await render('# Café\n\n## Same\n\n## Same\n\n## 日本語').done;
    const headings=[...document.querySelectorAll('#report h1,#report h2')];expect(new Set(headings.map(h=>h.id)).size).toBe(4);
    const links=[...document.querySelectorAll<HTMLAnchorElement>('#outline a')];links[2].click();
    expect(new URLSearchParams(location.hash.slice(1)).get('gist')).toBe(gist);expect(document.activeElement).toBe(headings[2]);
    expect(new URLSearchParams(location.hash.slice(1)).get('section')).toBe(headings[2].id);
  });
  it('SHARE-SAFE-HTML refuses executable URLs, event handlers, clobbering, embeds, images and CSS',async()=>{
    await render('# Safe\n<script>bad()</script><img src="https://tracker.invalid/a" onerror="bad()"><iframe srcdoc="bad"></iframe><form id="report"><input name="location"></form><style>@import "https://tracker.invalid"</style><svg onload="bad()"><a href="javascript:bad()">svg</a></svg><math><mtext>x</mtext></math>\n\n[bad](javascript:bad()) [good](https://example.com)').done;
    expect(document.querySelector('#report script,#report img,#report iframe,#report form,#report style,#report svg,#report math')).toBeNull();
    expect(document.querySelector('[onload],[onerror],[name=location]')).toBeNull();
    const links=[...document.querySelectorAll<HTMLAnchorElement>('#report a')];expect(links.find(a=>a.textContent==='bad')?.hasAttribute('href')).toBe(false);
    expect(links.find(a=>a.textContent==='good')?.rel).toBe('noopener noreferrer');
  });
  it('refuses diagram configuration/click directives without invoking Mermaid',async()=>{
    const f=render('```mermaid\n%%{init:{securityLevel:"loose"}}%%\ngraph TD; A-->B\n```');await f.done;
    expect(f.diagram).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Diagram unavailable');
  });
  it.each([404,403,429,503])('shows actionable failure for GitHub status %s',async status=>{
    await render('unavailable',status).done;expect(document.getElementById('status')?.getAttribute('role')).toBe('alert');expect(document.querySelector('#report h1')).toBeNull();
  });
  it('does not fetch malformed or missing locators',async()=>{
    history.replaceState(null,'','#gist=https://evil.invalid');const f=render('# none');await f.done;expect(f.request).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('complete link');
  });
});
