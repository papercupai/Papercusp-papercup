/** R-2 public bundle proof. LIVE=1 additionally exercises an owned harmless
 * secret Gist and actual Pages with a fresh anonymous browser, then deletes it. */
import {test,expect} from '@playwright/test';
import {createServer,type Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {buildReportViewer} from '@papercusp/operator-core/lib/report-sharing-viewer';
import {changeReportSharing,reportSharingGithub,type ReportShareStore,type ReportShare} from '@papercusp/operator-core/lib/report-sharing';
import type {ReportRecord} from '@papercusp/operator-core/lib/report-library';

const gist='alice/'+'a'.repeat(32);
const markdown='# Shared fixture\n\n## Findings\n\n| Item | Result |\n|---|---|\n| browser | passed |\n\n```js\nconst result = true;\n```\n\n## Diagram\n\n```mermaid\ngraph TD; A[Read] --> B[Done]\n```\n\n## Findings\n\n## 日本語';
let server:Server;let origin:string;
test.beforeAll(async()=>{
  const {files}=await buildReportViewer();
  server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname;const name=path==='/'?'index.html':path.slice(1);
    if(!(name in files)){res.writeHead(404);res.end();return;}
    res.setHeader('content-type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.setHeader('cache-control','no-store');res.end(files[name]);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
test.afterAll(async()=>{await new Promise<void>((resolve,reject)=>server?.close(error=>error?reject(error):resolve()));});

test('SHARE-READER actual bundled reader renders diagrams, tables and mobile outline without executing report markup',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let tracker=0;await page.route('https://tracker.invalid/**',async route=>{tracker++;await route.abort();});
  await page.route('https://api.github.com/gists/**',route=>route.fulfill({body:JSON.stringify({id:'a'.repeat(32),public:false,owner:{login:'alice'},files:{'report.md':{content:markdown+'\n<script>globalThis.canary=1</script><img src="https://tracker.invalid/pixel" onerror="globalThis.canary=2"><iframe srcdoc="bad"></iframe>\n\n[unsafe](javascript:globalThis.canary=3)'}}}),contentType:'application/json',headers:{'access-control-allow-origin':'*'}}));
  await page.goto(origin+'/#'+new URLSearchParams({gist}));
  await expect(page.locator('#report')).toBeVisible();await expect(page.locator('.diagram svg')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('browser');await expect(page.locator('code.language-js')).toContainText('const result');
  const headings=await page.locator('#report h1,#report h2').evaluateAll(nodes=>nodes.map(node=>node.id));expect(new Set(headings).size).toBe(headings.length);
  await page.getByRole('navigation',{name:'On this page'}).getByText('日本語').click();
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('gist')).toBe(gist);
  await page.reload();await expect(page.locator('.diagram svg')).toBeVisible();
  expect(await page.evaluate(()=>Reflect.get(globalThis,'canary'))).toBeUndefined();expect(tracker).toBe(0);expect(errors).toEqual([]);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await info.attach('reader-mobile',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});

if(process.env.PAPERCUSP_REPORT_SHARING_LIVE==='1') {
  test('SHARE-SHIPMENT actual secret Gist renders anonymously on Pages and a fresh reader fails after deletion',async({browser},info)=>{
    const github=await reportSharingGithub();const user=await github.user();
    const rows=new Map<string,ReportShare>();
    const store:ReportShareStore={async locked(_key,work){return work({list:async(w,r)=>[...rows.values()].filter(row=>row.workspaceId===w&&row.reportId===r),get:async(w,r,a)=>rows.get(JSON.stringify([w,r,a]))??null,
      put:async share=>{rows.set(JSON.stringify([share.workspaceId,share.reportId,share.accountId]),share);}});}};
    const now=new Date().toISOString();const reportId='sharing-fixture-'+randomUUID();
    const report:ReportRecord={workspaceId:'harmless-acceptance',reportId,title:'Harmless sharing acceptance',summary:'No private data',bodyMd:markdown,bodySha256:'',goalOwnerReport:null,kind:'other',subject:{kind:'none',ref:null,label:null},origin:{harnessSlug:null,authorOwnerId:null,authorSessionRef:null},visibility:'owner',supersedesReportId:null,lineageId:reportId,source:'owner',tags:[],publishedAt:now,updatedAt:now,retiredAt:null};
    const input={report,accountId:user.id};let url='';const network:unknown[]=[];const version=(await buildReportViewer()).version;
    try {
      await expect.poll(async()=>{
        const status=await changeReportSharing({...input,action:'share'},{github,store});url=status.url||'';return status.phase;
      },{timeout:180000,intervals:[5000,10000]}).toBe('ready');
      const context=await browser.newContext({storageState:{cookies:[],origins:[]}});const page=await context.newPage();
      const requests:string[]=[];page.on('request',request=>{requests.push(request.url());expect(request.headers().authorization).toBeUndefined();});
      page.on('response',response=>{if(response.url().includes('github.com'))network.push({phase:'before',url:response.url(),status:response.status(),cache:response.headers()['x-cache']});});
      await page.goto(url);await expect(page.locator('meta[name=papercusp-viewer-version]')).toHaveAttribute('content',version);
      await expect(page.locator('#report')).toBeVisible();await expect(page.locator('.diagram svg')).toBeVisible();
      await expect(page.getByRole('table')).toContainText('browser');
      await info.attach('actual-pages-reader',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
      expect(requests.some(request=>/https?:\/\/(?:localhost|127\.0\.0\.1)/.test(request))).toBe(false);
      await context.close();
      await changeReportSharing({...input,action:'stop'},{github,store});
      const fresh=await browser.newContext({storageState:{cookies:[],origins:[]}});const removed=await fresh.newPage();
      removed.on('response',response=>{if(response.url().includes('github.com'))network.push({phase:'after',url:response.url(),status:response.status(),cache:response.headers()['x-cache']});});
      await removed.goto(url);await expect(removed.locator('meta[name=papercusp-viewer-version]')).toHaveAttribute('content',version);
      await expect(removed.getByRole('alert')).toContainText(/unavailable|sharing has stopped/);
      await expect(removed.locator('#report')).toBeHidden();await fresh.close();
      await info.attach('actual-pages-lifecycle',{body:JSON.stringify({url,accountId:user.id,login:user.login,reportId,viewerVersion:(await buildReportViewer()).version,removed:true,verifiedAt:new Date().toISOString()}),contentType:'application/json'});
    } finally {
      try {await changeReportSharing({...input,action:'stop'},{github,store});}
      finally {
        const path=info.outputPath('fixture-recovery-state.json');await writeFile(path,JSON.stringify({url,version,network,accountId:user.id,login:user.login,reportId,shares:[...rows.values()],at:new Date().toISOString()},null,2));
        await info.attach('fixture-recovery-state',{path,contentType:'application/json'});
      }
    }
  });
}
