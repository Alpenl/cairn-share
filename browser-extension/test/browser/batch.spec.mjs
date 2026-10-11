import {chromium,expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../../scripts/build.mjs';

test('batch UI opens pages serially, resumes after worker death, skips login and changed targets, and uploads original bytes',async()=>{
  test.setTimeout(120000);
  let context,root,origin,extensionURL,worker;const posts=[],receipts=new Map(),images=new Map(),errors=[];
  const picture=await readFile(new URL('../../src/icons/48.png',import.meta.url));
  const tasks=()=>[1,2,3].map(id=>({id,url:origin+(id===1?'/source?keep=1#body':id===2?'/login':'/changed'),title:['','手机收藏的文章','需要登录的文章','已在另一台设备采集'][id],content_revision:1,app_body_revision:1}));
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,origin).pathname;
    if(path.startsWith('/api/')){
      if(req.headers.authorization!=='Bearer batch-token'){res.writeHead(401);res.end('{}');return;}
      res.setHeader('Content-Type','application/json');
      if(path==='/api/captures/v2/pending'){res.end(JSON.stringify({batch_version:1,items:tasks(),upper:3,next_after:null}));return;}
      if(path.startsWith('/api/captures/v2/pending/')){const id=Number(path.split('/').at(-1));res.end(JSON.stringify({batch_version:1,item:id===3?null:tasks()[id-1]}));return;}
      if(path==='/api/captures/v2'){
        let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);posts.push(body);const saved={id:body.target.id,url:body.url,note:body.note,completed:true};receipts.set(body.client_id,saved);res.end(JSON.stringify(saved));return;
      }
      if(path.startsWith('/api/captures/v2/')){
        const [,id,ordinal,media]=path.match(/v2\/([a-f0-9-]+)(?:\/(?:images\/(\d+)|(media)))?$/);
        if(req.method==='GET'){res.writeHead(receipts.has(id)?200:404);res.end(JSON.stringify(receipts.has(id)?{...receipts.get(id),images_ready:images.has(id)?[0]:[]}:{}));return;}
        const chunks=[];for await(const c of req)chunks.push(c);
        if(media){res.end('{}');return;}
        if(req.method==='PUT')images.set(id,Buffer.concat(chunks));
        res.end(JSON.stringify({status:images.has(id)?'ready':'pending'}));return;
      }
      res.end(JSON.stringify({items:[]}));return;
    }
    if(path==='/source'){res.writeHead(302,{Location:'/article'});res.end();return;}
    if(path==='/image.png'){res.setHeader('Content-Type','image/png');res.end(picture);return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(path==='/login'?'<title>登录</title><main><input type="password"><p>请登录后阅读</p></main>':
      '<title>批量采集测试文章</title><article><h1>手机收藏，浏览器补全</h1><p>这是一篇通过浏览器页面取得的完整原文，包含多段文字和实际图片。用于验证后台采集完成之后，仍然更新手机端已有收藏，保留完整的原链接。</p><img src="/image.png" alt="配图"></article>');
  });
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
    root=await mkdtemp(join(tmpdir(),'cairn-batch-'));await build({outputRoot:join(root,'build'),apiBase:origin,pack:false});
    const folder=join(root,'build/chrome'),manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
    // Pregrant in the test profile only; real installations request this from
    // the user's start click. No external sites are contacted in this fixture.
    manifest.host_permissions.push('http://*/*','https://*/*');await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest));
    context=await chromium.launchPersistentContext(join(root,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${folder}`,`--load-extension=${folder}`,'--no-sandbox']});
    context.on('page',p=>p.on('pageerror',e=>errors.push(String(e))));
    worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');extensionURL=worker.url().replace('/background.mjs','');
    const options=await context.newPage();await options.goto(extensionURL+'/options.html');
    await options.locator('#token').fill('batch-token');await options.locator('#connect').click();await expect(options.locator('#status')).toContainText('连接成功');
    const dashboard=await context.newPage();await dashboard.goto(extensionURL+'/batch.html');
    await dashboard.locator('#start').click();await expect(dashboard.locator('#count')).toHaveText('0 / 3');
    await expect.poll(()=>worker.evaluate(async()=>(await chrome.storage.local.get('cairn_batch_v1')).cairn_batch_v1.tabId)).toBeTruthy();
    await dashboard.locator('#pause').click();await expect(dashboard.locator('#phase')).toHaveText('已暂停');
    await dashboard.locator('#resume').click();
    await expect.poll(()=>worker.evaluate(async()=>(await chrome.storage.local.get('cairn_batch_v1')).cairn_batch_v1.tabId)).toBeTruthy();
    const cdp=await context.newCDPSession(dashboard);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
    await dashboard.close();
    // Opening options wakes the worker; closing the progress UI does not own
    // task lifetime. Session storage retains only this browser's owned tab.
    await options.reload();
    await expect.poll(()=>posts.length,{timeout:40000}).toBe(1);
    await expect.poll(()=>images.size,{timeout:15000}).toBe(1);
    const result=await context.newPage();await result.goto(extensionURL+'/batch.html');
    await expect(result.locator('#phase')).toHaveText('本轮采集结束',{timeout:25000});
    await expect(result.locator('#totals')).toHaveText('已采集 1 · 需处理 1 · 跳过 1');
    await expect(result.locator('#pending-count')).toHaveText('0');
    expect(posts[0].target).toEqual({id:1,content_revision:1,app_body_revision:1});
    expect(posts[0].url).toBe(tasks()[0].url);expect(posts[0].capture.text).toContain('完整原文');
    expect(images.get(posts[0].client_id)).toEqual(picture);
    expect(context.pages().some(p=>p.url()===origin+'/article'||p.url()===origin+'/login')).toBe(false);
    await result.screenshot({path:'test-results/batch-complete.png',fullPage:true});expect(errors).toEqual([]);
  } finally {
    await context?.close();await new Promise(r=>{server.closeAllConnections();server.close(r);});if(root)await rm(root,{recursive:true,force:true});
  }
});
