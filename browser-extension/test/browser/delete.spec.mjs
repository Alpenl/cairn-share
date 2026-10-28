import { chromium, expect, test } from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../../scripts/build.mjs';

test('popup confirms deletion, recovers response loss after reopening and keeps custom-origin guards', async()=>{
 let context,root,deleted=false,lost=true,origin;
 const token='cairn_c_'+'d'.repeat(64),writes=[];
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,origin).pathname;
  const ok=data=>{res.setHeader('Content-Type','application/json');res.setHeader('X-Cairn-Collections','1');res.end(JSON.stringify({code:'OK',data}));};
  if(!path.startsWith('/api/')){res.end('<title>Saved page</title>');return;}
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
  if(path.endsWith('/links/lookup'))return ok({saved:!deleted,id:7,personal_revision:3,content_revision:2,app_body_revision:1});
  if(path.endsWith('/links/7')&&req.method==='DELETE'){
   let raw='';for await(const c of req)raw+=c;writes.push(JSON.parse(raw));deleted=true;
   if(lost){lost=false;res.writeHead(200,{'Content-Type':'application/json'});res.write('{"code":');setTimeout(()=>res.destroy(),100);return;}return ok({id:7,deleted:true,revision:4});
  }
  if(path.endsWith('/tags')){res.writeHead(404);res.end();return;}
  return ok({items:[]});
 });
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  root=await mkdtemp(join(tmpdir(),'cairn-delete-'));await build({outputRoot:join(root,'build'),apiBase:origin,pack:false});
  const folder=join(root,'build/chrome');context=await chromium.launchPersistentContext(join(root,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${folder}`,`--load-extension=${folder}`,'--no-sandbox']});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const base=worker.url().replace('/background.mjs','');
  const options=await context.newPage();await options.goto(base+'/options.html');await options.locator('#token').fill(token);await options.locator('#connect').click();await expect(options.locator('#status')).toContainText('连接成功');
  const popup=await context.newPage();await popup.addInitScript(url=>{chrome.tabs.query=async()=>[{url,title:'Saved page'}]},origin+'/article');await popup.goto(base+'/popup.html');
  await expect(popup.locator('#delete-saved')).toBeVisible();
  popup.once('dialog',d=>d.dismiss());await popup.locator('#delete-saved').click();expect(writes).toHaveLength(0);
  popup.once('dialog',d=>d.accept());await popup.locator('#delete-saved').click();await expect(popup.locator('#delete-saved')).toHaveText('重试删除');
  await popup.reload();await expect(popup.locator('#delete-saved')).toHaveText('重试删除');
  await popup.locator('#delete-saved').click();await expect(popup.locator('#status')).toContainText('已移到回收站');await expect(popup.locator('#saved-badge')).toBeHidden();
  expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);expect(writes[0].expected_revision).toBe(3);
  expect((await worker.evaluate(async()=>(await chrome.storage.local.get('cairn_capture_v1')).cairn_capture_v1)).deletion).toBeUndefined();
  await popup.screenshot({path:'test-results/delete-popup.png'});
 }finally{await context?.close();await new Promise(r=>{server.closeAllConnections();server.close(r)});if(root)await rm(root,{recursive:true,force:true});}
});
