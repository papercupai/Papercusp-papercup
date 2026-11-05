/** Versioned reusable Pages assets. Arguments cannot contain report data. */
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { startReportViewer, sanitizeReportMarkup } from './report-sharing-browser';

export const REPORT_VIEWER_REPO = 'papercusp-reports';
export const REPORT_VIEWER_MARKER = 'papercusp-report-viewer-v1';
export interface ReportViewerAssets { files: Record<string, string>; version: string }
let bundled: Promise<ReportViewerAssets> | undefined;

export function buildReportViewer(): Promise<ReportViewerAssets> {
  return bundled ??= makeAssets().catch(error => { bundled = undefined; throw error; });
}

async function makeAssets(): Promise<ReportViewerAssets> {
  const source = `import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:30000,maxEdges:300,
  flowchart:{htmlLabels:false},secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','flowchart']});
const start = ${startReportViewer.toString()};
const sanitize = ${sanitizeReportMarkup.toString()};
void start(document, {
 markdown: source => marked.parse(source,{async:false}),
 sanitize: (html,svg) => sanitize(DOMPurify,html,svg),
 diagram: async (text,id) => (await mermaid.render(id,text)).svg
});`;
  const require = createRequire(import.meta.url);
  const result = await build({ stdin: { contents: source, resolveDir: dirname(require.resolve('marked/package.json')), sourcefile: 'viewer-entry.js' },
    bundle: true, write: false, minify: true, platform: 'browser', format: 'iife', target: ['es2022'], legalComments: 'none', sourcemap: false });
  const js = result.outputFiles[0].text;
  const css = `:root{color-scheme:light dark;font:16px/1.65 system-ui,sans-serif;background:#f6f7fa;color:#242936}*{box-sizing:border-box}body{margin:0}header{padding:18px 32px;border-bottom:1px solid #ccc}header b{font-size:18px}#status{font-size:13px;max-width:1000px;margin:4px 0}main{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:48px;padding:36px}article{min-width:0;overflow-wrap:anywhere;background:white;padding:32px;border-radius:10px;box-shadow:0 1px 8px #0001}h1,h2,h3,h4,h5,h6{line-height:1.3;scroll-margin-top:24px}h1{font-size:2.2rem}h2{margin-top:2em;border-bottom:1px solid #ddd;padding-bottom:.4em}a{color:#315cc5}aside{position:sticky;top:24px;align-self:start;max-height:90vh;overflow:auto}#outline a{display:block;padding:6px 12px;line-height:1.45;font-size:14px;border-left:2px solid #ccd3e0}pre{overflow:auto;background:#eef0f5;padding:18px;border-radius:6px}code{font:14px/1.6 ui-monospace,monospace}p code{background:#eef0f5;padding:2px 4px}blockquote{margin-left:0;border-left:3px solid #9aaacb;padding-left:20px;color:#5c6476}.table-scroll,.diagram{max-width:100%;overflow:auto}table{border-collapse:collapse;font-size:14px;width:100%}td,th{padding:10px 14px;border:1px solid #d6dce8;text-align:left}th{background:#eef0f5}.diagram svg{max-width:100%;height:auto}summary{cursor:pointer}:focus-visible{outline:3px solid #638cf0;outline-offset:3px}@media(max-width:760px){main{display:flex;flex-direction:column;padding:16px;gap:16px}article{padding:20px}aside{position:static;order:-1;max-height:240px}header{padding:16px}h1{font-size:1.8rem}}@media(prefers-color-scheme:dark){:root{background:#171b24;color:#e2e6f0}article{background:#202633}a{color:#9ab8ff}pre,p code,th{background:#171b24}td,th{border-color:#414b60}blockquote{color:#b7c1d6}}`;
  const version = createHash('sha256').update(js).update(css).digest('hex');
  // GitHub Pages cannot set arbitrary response headers. A meta CSP plus a
  // referrer meta cover this static document without adding a hosted service.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src https://gist.githubusercontent.com; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><meta name="papercusp-viewer-version" content="${version}"><title>Shared report</title><link rel="stylesheet" href="./viewer.${version}.css"></head><body><header><b>Shared report</b><p id="status" role="status" aria-live="polite"></p></header><main><article id="report" hidden></article><aside><details open><summary>On this page</summary><nav id="outline" aria-label="On this page"></nav></details></aside></main><script src="./viewer.${version}.js" defer></script></body></html>`;
  return { version, files: { 'index.html': html.replace('connect-src https://gist.githubusercontent.com','connect-src https://api.github.com'), ['viewer.'+version+'.js']: js, ['viewer.'+version+'.css']: css,
    'viewer.json': JSON.stringify({ kind: REPORT_VIEWER_MARKER, version }), '.nojekyll': '' } };
}
