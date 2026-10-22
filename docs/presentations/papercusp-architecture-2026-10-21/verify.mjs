// Artifact rehearsal: real browser navigation, layout, offline maps and PDF.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// A fixture root lets the framework exercise corrupted copies without editing delivery files.
const root = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await readFile(join(root, 'slides.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });
const started = Date.now();
const checks = [], errors = [], external = [];
await mkdir(join(root, 'evidence'), { recursive: true });
try {
  for (const viewport of [{width:1440,height:900},{width:1280,height:720}]) {
    const context = await browser.newContext({ viewport, offline: true });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
    await page.goto(pathToFileURL(join(root, 'index.html')).href);
    for (const [index, slide] of data.slides.entries()) {
      await page.evaluate(id => { location.hash = id; }, slide.id);
      await page.waitForFunction(id => document.querySelector('.slide.active')?.id === id, slide.id);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('.slide:visible').count(),1,'exactly one slide must be displayed');
      assert.ok(Math.abs((await page.locator('.slide.active').boundingBox()).y)<1,'active slide must start at viewport top');
      const layout = await page.locator('.slide.active').evaluate(s => {
        const footer = s.querySelector('footer').getBoundingClientRect();
        const content = s.querySelector('.content').getBoundingClientRect();
        const bad = [...s.querySelectorAll('h1,.cards article,.columns article,.terms,.steps,.question,.caption,.points')].filter(n => {
          const r=n.getBoundingClientRect();
          return r.bottom > footer.top + 1 || r.right > s.clientWidth + 1 || r.left < -1;
        }).map(n=>n.className || n.tagName);
        return {bad,overflow:s.scrollHeight>s.clientHeight+1,contentBottom:content.bottom,footerTop:footer.top};
      });
      assert.deepEqual(layout.bad, [], slide.id+' layout at '+viewport.width+': '+JSON.stringify(layout));
      assert.equal(layout.overflow,false,slide.id+' overflow at '+viewport.width);
      assert.ok((slide.notes||'').length>80,slide.id+' lacks substantive notes');
      if (viewport.width===1440 && ['system','capabilities','trace-claim'].includes(slide.id)) {
        const name={system:'overview',capabilities:'concepts','trace-claim':'trace'}[slide.id];
        await page.screenshot({path:join(root,'evidence',name+'.png')});
      }
      if (index===0) {
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(()=>document.querySelector('.slide.active')?.id==='system');
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(()=>document.querySelector('.slide.active')?.id==='thesis');
      }
    }
    await page.evaluate(()=>{location.hash='capabilities'});
    await page.waitForFunction(()=>document.querySelector('.slide.active')?.id==='capabilities');
    await page.keyboard.press('n');
    assert.ok(await page.locator('.slide.active .notes').isVisible());
    await page.keyboard.press('Escape');
    assert.ok(!await page.locator('.slide.active .notes').isVisible());
    await page.keyboard.press('o');
    assert.ok(await page.locator('#overview').isVisible());
    await page.locator('#overview a[href="#trace-cupboard"]').click();
    await page.waitForFunction(()=>document.querySelector('.slide.active')?.id==='trace-cupboard');
    await page.reload();
    assert.equal(await page.locator('.slide.active').getAttribute('id'),'trace-cupboard');
    for (const name of ['architecture','cupboard']) {
      await page.locator('#'+name+'-map').click();
      const frame=page.frameLocator('#map-frame');
      await frame.locator('#map svg').waitFor();
      const before=await frame.locator('#map > svg').getAttribute('viewBox');
      await frame.locator('.mz-in').click();
      await page.waitForTimeout(700);
      const after=await frame.locator('#map > svg').getAttribute('viewBox');
      assert.notEqual(before,after,name+' zoom must change viewBox');
      assert.equal(await frame.locator('audio').count(),0,name+' has no narration element');
      await page.locator('#map-close').click();
      assert.equal(await page.locator('dialog').isVisible(),false);
      // Direct local map link also resolves and remains independent of a server.
      const mapPage=await context.newPage();
      mapPage.on('pageerror',e=>errors.push(e.message));
      await mapPage.goto(pathToFileURL(join(root,'maps',name+'.html')).href);
      assert.ok(await mapPage.locator('#map svg').isVisible());
      await mapPage.close();
    }
    checks.push({viewport,slides:data.slides.length,offline:true,navigation:true,notes:true,overview:true,deepLinkReload:true,localMapZoom:true});
    await context.close();
  }
  assert.deepEqual(errors,[],'browser errors');
  assert.deepEqual(external,[],'core deck must not request network assets');
  const context=await browser.newContext({viewport:{width:1280,height:720},offline:true});
  const page=await context.newPage();
  await page.goto(pathToFileURL(join(root,'index.html')).href);
  await page.pdf({path:join(root,'deck.pdf'),width:'13.333in',height:'7.5in',printBackground:true,preferCSSPageSize:true,tagged:true});
  const info=execFileSync('pdfinfo',[join(root,'deck.pdf')],{encoding:'utf8'});
  const pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  assert.equal(pages,data.slides.length,'one PDF page per slide');
  const pdfText=execFileSync('pdftotext',[join(root,'deck.pdf'),'-'],{encoding:'utf8'});
  for(const s of data.slides) {
    const text=pdfText.replace(/\s+/g,' ');
    assert.ok(text.includes(s.title.replace(/\s+/g,' ')), 'PDF missing title '+s.id);
  }
  assert.ok(!pdfText.includes('Presenter notes'),'private notes must not appear in PDF');
  await context.close();
  const files=['index.html','deck.pdf','presenter-notes.md','slides.json','build.mjs','verify.mjs','README.md','maps/architecture.html','maps/cupboard.html','maps/architecture.svg','maps/cupboard.svg'];
  const fingerprints=await Promise.all(files.map(async path=>({path,bytes:(await stat(join(root,path))).size,sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')})));
  const result={status:'passed',checkedAt:new Date().toISOString(),mechanicalWalkthroughSeconds:Math.round((Date.now()-started)/1000),checks,pdf:{pages,notesExcluded:true,titleCoverage:'every slide'},networkRequests:external,browserErrors:errors,files:fingerprints,spokenTiming:{proposedContentSeconds:data.slides.reduce((n,s)=>n+(s.seconds||0),0),questionBufferSeconds:100,humanRehearsal:'not performed'},limits:['Chromium desktop rendering and local file delivery were checked; projector and other browser engines require presenter rehearsal.','Mechanical walkthrough time is not human spoken presentation time.','Page content is a development-source snapshot, not certification of all product behavior.']};
  await writeFile(join(root,'verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({status:result.status,checks:checks.length,pdfPages:pages,mechanicalSeconds:result.mechanicalWalkthroughSeconds}));
} finally { await browser.close(); }
