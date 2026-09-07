import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1200,height:900}});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/permissions-fixture',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><style>body{margin:0;background:#090a0b;color:#eee}.views{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px}.view{min-width:0;height:820px;border:1px solid #52534b}h2{font:14px monospace;margin:12px}@media(max-width:700px){.views{grid-template-columns:1fr}.view{height:720px}}</style></head><body><div class="views"><section class="view"><h2>PERMISSION ESCALATION</h2><main class="win__body" id="interrupt"></main></section><section class="view"><h2>AGENT DETAILS</h2><main class="win__body" id="agent" style="height:760px"></main></section></div></body></html>`}));
 await page.goto('http://127.0.0.1:4478/permissions-fixture');
 await page.evaluate(async()=>{await import('/test/permissions-window.fixture.ts' as string);});
 await page.locator('#agent').getByRole('tab',{name:/Details/i}).click();
 await page.locator('#interrupt [data-opt="allow"]').click();
 for(const scope of ['#interrupt','#agent']) {
   await page.locator(scope).getByText(/RESPONSE PENDING/).waitFor();
   assert.equal(await page.locator(`${scope} [data-opt]:disabled`).count(),2);
   assert.equal(await page.locator(`${scope} [data-remember]`).innerText(),'');
 }
 assert.equal(await page.locator('#interrupt').isVisible(),true);
 const state=await page.evaluate(async()=> (await import('/test/permissions-window.fixture.ts' as string)).events);
 assert.deepEqual(state,{answers:1,closed:0});
 await mkdir('test/shots',{recursive:true});
 await page.screenshot({path:'test/shots/permissions-pending-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.locator('.view').nth(1).evaluate(el => (el as HTMLElement).style.display='none');
 await page.screenshot({path:'test/shots/permissions-pending-mobile.png'});
 await page.locator('.view').nth(0).evaluate(el => (el as HTMLElement).style.display='none');
 await page.locator('.view').nth(1).evaluate(el => (el as HTMLElement).style.display='block');
 await page.screenshot({path:'test/shots/permissions-agent-pending-mobile.png'});
 await page.locator('.view').nth(0).evaluate(el => (el as HTMLElement).style.display='block');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(async()=>{(await import('/test/permissions-window.fixture.ts' as string)).update('confirmed');});
 await page.locator('#interrupt').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log('PASS pending visible in both production views; disabled answers, no remember, stays open until confirmed; desktop/mobile screenshots.');
} finally {await browser.close();}
