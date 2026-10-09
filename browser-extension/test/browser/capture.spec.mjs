import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build.mjs";

let context, server, origin, extensionURL, worker, root, mediaServer, mediaOrigin;
const mediaUploads=new Map();
const imageUploads=new Map();
let holdImages=false,failImage=null;
const imageRequests=[];
let failSecondPart=false;const partRequests=[];
const movie=Buffer.alloc(9*1024*1024,42);movie.write("ftypisom",4);
const picture=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a42kAAAAASUVORK5CYII=","base64");
let offline = false, holdResponse = false, releaseResponse;
const posts = [];
const records = new Map();
const errors = [];
let collectionEnabled=false,loseCollection=false;const collectionId=crypto.randomUUID();const collectionPosts=[];const collectionReceipts=new Set();

test.beforeAll(async () => {
  mediaServer=createServer((req,res)=>{const bytes=req.url==='/movie.mp4'?movie:picture;res.writeHead(200,{'Content-Type':req.url==='/movie.mp4'?'video/mp4':'image/png','Content-Length':bytes.length});res.end(bytes);});
  await new Promise(resolve=>mediaServer.listen(0,'127.0.0.1',resolve));mediaOrigin=`http://localhost:${mediaServer.address().port}`;
  server = createServer(async (request, response) => {
    if(collectionEnabled&&request.url.startsWith('/api/collections')){
      if(request.headers.authorization!=='Bearer browser-test-token'){response.writeHead(401);response.end();return;}
      response.setHeader('Content-Type','application/json');response.setHeader('X-Cairn-Collections','1');
      if(request.method==='GET'){response.end(JSON.stringify({items:[{id:collectionId,name:'设计参考',revision:1,deleted:0,archived:0,pinned:1}]}));return;}
      let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw);collectionPosts.push(body);collectionReceipts.add(body.operation_key);
      if(loseCollection){loseCollection=false;response.writeHead(200);response.write('{"revision":');setTimeout(()=>response.destroy(),100);return;}response.end(JSON.stringify({revision:2}));return;
    }
    if(request.url.startsWith('/api/captures/v2/')) {
      if(request.headers.authorization!=='Bearer browser-test-token'){response.writeHead(401);response.end();return;}
      const [,id,ordinal,media]=request.url.match(/v2\/([a-f0-9-]+)(?:\/(?:images\/(\d+)|(media)))?$/);
      response.setHeader('Content-Type','application/json');
      const saved=records.get(id);if(!saved){response.writeHead(404);response.end('{}');return;}
      if(request.method==='GET'){response.end(JSON.stringify({...saved,completed:true,images_ready:[...imageUploads.entries()].filter(([k,v])=>k.startsWith(id+':')&&v.bytes).map(([k])=>Number(k.split(':')[1]))}));return;}
      const chunks=[];for await(const c of request)chunks.push(c);const raw=Buffer.concat(chunks);
      if(media){response.end('{}');return;}
      const key=id+':'+ordinal;
      if(request.method==='POST'){
        if(!imageUploads.has(key))imageUploads.set(key,JSON.parse(raw));
        response.end(JSON.stringify({status:imageUploads.get(key).bytes?'ready':'pending'}));return;
      }
      imageRequests.push(key);
      if(failImage===Number(ordinal)){response.writeHead(503);response.end('{}');return;}
      imageUploads.get(key).bytes=raw;
      while(holdImages&&!response.destroyed)await new Promise(r=>setTimeout(r,20));
      if(!response.destroyed)response.end(JSON.stringify({status:'ready'}));return;
    }
    if(request.url.startsWith('/api/media/uploads/')) {
      if(request.headers.authorization!=='Bearer browser-test-token'){response.writeHead(401);response.end();return;}
      const [,id,action]=request.url.match(/uploads\/([a-f0-9]+)(?:\/(.+))?$/);const chunks=[];for await(const c of request)chunks.push(c);const raw=Buffer.concat(chunks);
      let saved=mediaUploads.get(id);response.setHeader('Content-Type','application/json');
      if(!action){if(!saved){saved={status:'uploading',parts:[],bytes:[],...JSON.parse(raw)};mediaUploads.set(id,saved);}response.end(JSON.stringify({...saved,bytes:undefined,chunk_size:8*1024*1024}));return;}
      if(action==='complete'){saved.status='ready';response.end(JSON.stringify({status:'ready'}));return;}
      const number=Number(action);partRequests.push(number);if(number===2&&failSecondPart){response.writeHead(503);response.end('{}');return;}saved.parts[number-1]={partNumber:number};saved.bytes[number-1]=raw;response.end(JSON.stringify({part:number}));return;
    }
    if (request.url.startsWith("/api/")) {
      if (offline) { response.writeHead(503); response.end(); return; }
      if (request.headers.authorization !== "Bearer browser-test-token") { response.writeHead(401); response.end(); return; }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") { response.end(JSON.stringify({ items: [], next_before_id: null })); return; }
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      posts.push(body);
      const saved = records.get(body.client_id) ?? { id: records.size + 1, ...body };
      records.set(body.client_id, saved);
      if (holdResponse) await new Promise((resolve) => { releaseResponse = resolve; });
      response.end(JSON.stringify(saved));
      return;
    }
    if (request.url === "/image.svg") { response.setHeader("Content-Type", "image/svg+xml");response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#6d8d73"/></svg>');return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>一篇值得收藏的文章</title><main><h1>浏览器测试页面</h1><a href='https://example.org/right-click?x=1#part'>示例链接</a></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  root = await mkdtemp(join(tmpdir(), "cairn-browser-"));
  await build({ outputRoot: join(root, "build"), apiBase: origin, pack: false });
  const extensionPath = join(root, "build", "chrome");
  // Grant only our synthetic CDN in this fixture. The real optional permission
  // request still executes, and the image response deliberately has no CORS.
  const manifest=JSON.parse(await readFile(join(extensionPath,'manifest.json'),'utf8'));manifest.host_permissions.push('http://localhost/*');await writeFile(join(extensionPath,'manifest.json'),JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"]
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(String(error))));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const workerURL = new URL(worker.url());
  extensionURL = `${workerURL.protocol}//${workerURL.host}`;
});

test.afterAll(async () => {
  if (releaseResponse) releaseResponse();
  await context?.close();
  await new Promise(resolve=>{mediaServer.closeAllConnections();mediaServer.close(resolve);});
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(root, { recursive: true, force: true });
});

test("real extension: connection, exact capture, close popup, queue retry and background restart", async () => {
  const options = await context.newPage();
  await options.goto(`${extensionURL}/options.html`);
  await expect(options.locator("#connect")).toBeEnabled();
  await options.locator("#token").fill("wrong-token");
  await options.locator("#connect").click();
  await expect(options.locator("#status")).toContainText("访问令牌不可用");
  await options.locator("#token").fill("browser-test-token");
  await options.locator("#connect").click();
  await expect(options.locator("#status")).toContainText("连接成功");
  await expect(options.locator("#token")).toHaveValue("");

  const page = await context.newPage();
  const exactURL = `${origin}/article?x=%20&keep=2#section`;
  await page.goto(exactURL);
  // Opening extension HTML in a tab loses the native action's activeTab
  // grant; inject only the tab query in this test, keeping real background,
  // messaging, local storage, permissions and HTTP requests intact.
  const popup = await context.newPage();
  await popup.addInitScript(({ url }) => {
    chrome.tabs.query = async () => [{ url, title: "一篇值得收藏的文章" }];
  }, { url: exactURL });
  await popup.goto(`${extensionURL}/popup.html`);
  await expect(popup.locator("#url")).toHaveValue(exactURL);
  await popup.locator("#note").fill("保留参数，稍后再读");
  holdResponse = true;
  await popup.locator("#save").click();
  await expect.poll(() => posts.length).toBe(1);
  await popup.close();
  holdResponse = false;
  releaseResponse();
  releaseResponse = null;
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get("cairn_capture_v1")).cairn_capture_v1.queue.length)).toBe(0);
  expect(posts[0].url).toBe(exactURL);
  expect(posts[0].note).toBe("保留参数，稍后再读");
  expect(Object.keys(posts[0]).sort()).toEqual(["client_id", "note", "url"]);

  offline = true;
  const queued = await context.newPage();
  await queued.goto(`${extensionURL}/popup.html`);
  await queued.locator("#url").fill("https://example.com/offline?keep=true#part");
  await queued.locator("#note").fill("离线也不能丢");
  await queued.locator("#save").click();
  await expect(queued.locator("#queue")).toContainText("服务暂时不可用");
  const clientId = await worker.evaluate(async () => (await chrome.storage.local.get("cairn_capture_v1")).cairn_capture_v1.queue[0].client_id);
  await queued.close();
  // Kill the service worker to exercise reconstruction from durable storage.
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  offline = false;
  await options.reload();
  await expect(options.locator("#pending-count")).toHaveText("1");
  await options.locator("#retry-all").click();
  await expect(options.locator("#pending-count")).toHaveText("0");
  expect(posts.at(-1).client_id).toBe(clientId);
  expect(posts.at(-1).note).toBe("离线也不能丢");

  // A server HTML fragment in the title or note must remain text.
  const hostile = await context.newPage();
  await hostile.goto(`${extensionURL}/popup.html`);
  await hostile.locator("#url").fill("https://example.com/security");
  await hostile.locator("#note").fill('<img src=x onerror="alert(1)">');
  await hostile.locator("#save").click();
  await expect(hostile.locator("#status")).toContainText("已上传");
  expect(posts.at(-1).note).toContain("<img");
  await hostile.locator("body").screenshot({ path: "test-results/cairn-popup.png" });
  await options.screenshot({ path: "test-results/cairn-options.png", fullPage: true });
  expect(errors).toEqual([]);
});


test("capture rendered content with real scripting and keep success visible in a compact popup", async () => {
  const article = await context.newPage();
  await article.goto(`${origin}/rendered-article`);
  await article.evaluate(() => {
    document.body.innerHTML = '<nav>Navigation noise</nav><article><h1>已加载文章</h1><p>这段正文来自浏览器。</p><ul><li>第一项</li><li>第二项</li></ul><input value="private form"><script>window.secret="ignored"</script><p hidden>隐藏内容</p></article>';
  });
  await article.evaluate(async () => {
    const img=document.createElement('img');img.src='/image.svg';img.alt='已加载配图';document.querySelector('article').append(img);await img.decode();
  });
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url), article.url());
  const popup = await context.newPage();
  await popup.setViewportSize({width:380,height:580});
  await popup.addInitScript(tab => { chrome.tabs.query=async()=>[tab]; },tab);
  await popup.goto(`${extensionURL}/popup.html`);
  await expect(popup.locator('#save')).toBeEnabled();
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toContainText('张图片');
  const saved=posts.find(p=>p.url===article.url());
  expect(saved.capture.text).toContain('# 已加载文章');
  expect(saved.capture.text).toMatch(/^-\s+第一项$/m);
  expect(saved.capture.text).toContain('![已加载配图](cairn-image:0)');
  expect(saved.capture.images).toHaveLength(1);
  expect(saved.capture.images[0].data).toBeUndefined();
  const archived=imageUploads.get(saved.client_id+':0');
  expect(archived.content_type).toBe('image/webp');
  expect(archived.bytes.length).toBeGreaterThan(40);
  expect(saved.capture.text).not.toContain('Navigation noise');
  expect(saved.capture.text).not.toContain('private form');
  expect(saved.capture.text).not.toContain('隐藏内容');
  const box=await popup.locator('#status').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(580);
  await expect(popup.locator('#save')).toHaveText('已保存');
  await expect(popup.locator('#save')).toBeDisabled();
  await popup.screenshot({path:'test-results/capture-success.png'});
  await popup.reload();await expect(popup.locator('#status')).toContainText('已同步');
  await popup.locator('#note').fill('补充备注');await expect(popup.locator('#save')).toBeEnabled();
  await article.close();await popup.close();
});


test('archives lazy cross-origin image bytes and resumes a video using durable multipart state',async()=>{
 await worker.evaluate(()=>chrome.storage.local.remove('cairn_capture_draft'));failSecondPart=true;
 const article=await context.newPage();await article.goto(`${origin}/lazy-media`);
 await article.evaluate(mediaOrigin=>{document.body.innerHTML=`<article><h1>懒加载图文</h1><p>配图与视频归档。</p><img data-src="${mediaOrigin}/photo.png" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><video preload="none"><source src="${mediaOrigin}/movie.mp4" type="video/mp4"></video></article>`;},mediaOrigin);
 const tab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),article.url());
 const popup=await context.newPage();await popup.addInitScript(tab=>{chrome.tabs.query=async()=>[tab];},tab);await popup.goto(`${extensionURL}/popup.html`);
 await popup.locator('#save').click();await expect(popup.locator('#queue')).toContainText('服务暂时不可用');
 await popup.close();const cdp=await context.newCDPSession(article);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');failSecondPart=false;
 const resumed=await context.newPage();await resumed.goto(`${extensionURL}/options.html`);await resumed.locator('#retry-all').click();await expect(resumed.locator('#pending-count')).toHaveText('0');
 const result=await worker.evaluate(async()=>(await chrome.storage.local.get('cairn_capture_v1')).cairn_capture_v1.lastResult);expect(result.mediaSaved).toBe(1);expect(partRequests.filter(n=>n===1)).toHaveLength(1);await resumed.close();
 const saved=posts.find(p=>p.url===article.url());expect(saved.capture.images).toHaveLength(1);expect(imageUploads.get(saved.client_id+':0').bytes).toEqual(picture);expect(saved.capture.missing_images).toBe(0);
 expect(saved.capture.media).toHaveLength(1);const upload=[...mediaUploads.values()].at(-1);expect(upload.parts).toHaveLength(2);expect(Buffer.concat(upload.bytes)).toEqual(movie);
 expect(await worker.evaluate(async()=>new Promise((resolve,reject)=>{const r=indexedDB.open('cairn-media-queue',1);r.onsuccess=()=>{const c=r.result.transaction('files').objectStore('files').count();c.onsuccess=()=>{resolve(c.result);r.result.close();};};r.onerror=reject;}))).toBe(0);
 await article.close();
});


test('library extractor isolates the selected X post and keeps paragraphs, links and media',async()=>{
 const page=await context.newPage();
 await page.route('https://x.com/Example/status/123',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><body>
 <article data-testid="tweet"><a href="/Example/status/123"><time>12:00</time></a><div data-testid="User-Name"><a href="/Example">Example</a><a href="/Example">@Example</a></div>
 <div>翻译自 韩语</div><div data-testid="tweetText">第一段正文。

第二段正文，有 <a href="https://example.org/paper">原始论文</a>。</div><div>评价此翻译：</div><a href="/Example/status/123/analytics">9万 查看</a><button>转发</button><video src="https://video.twimg.com/example.mp4"></video></article>
 <article data-testid="tweet"><div data-testid="tweetText">推荐广告，不属于收藏</div></article></body></html>`}));
 await page.goto('https://x.com/Example/status/123');
 await page.addScriptTag({content:await readFile(join(root,'build/chrome/capture-extractor.js'),'utf8')});
 const result=await page.evaluate(()=>globalThis.__cairnExtractPage(location.href,true));
 expect(result.text).toContain('第一段正文。');expect(result.text).toContain('第二段正文');expect(result.text).not.toMatch(/翻译自|评价此翻译|推荐广告|9万|@Example/);
 expect(result.text).toContain('https://example.org/paper');expect(result.media).toHaveLength(1);expect(result.media[0].url).toBe('https://video.twimg.com/example.mp4');
 await page.close();
});


test("choose a collection during capture and resume its committed lost response without recapturing",async()=>{
 collectionEnabled=true;loseCollection=true;const before=posts.length;
 const popup=await context.newPage();await popup.goto(`${extensionURL}/popup.html`);await popup.locator('#url').fill('https://example.com/collection-capture');
 await expect(popup.locator('#collection-choices')).toContainText('设计参考');await popup.getByRole('checkbox',{name:'设计参考'}).check();await popup.locator('#save').click();
 await expect(popup.locator('#queue')).toContainText('服务器响应异常');await popup.close();
 const retry=await context.newPage();await retry.goto(`${extensionURL}/options.html`);await retry.locator('#retry-all').click();await expect(retry.locator('#pending-count')).toHaveText('0');
 expect(posts.length-before).toBe(1);expect(collectionPosts.length).toBe(2);expect(collectionPosts[0]).toEqual(collectionPosts[1]);expect(collectionReceipts.size).toBe(1);expect(collectionPosts[0].link_ids).toEqual([records.get(posts.at(-1).client_id).id]);
 collectionEnabled=false;
});


test('text confirmation stays visible during slow images; background restart confirms saved files instead of reuploading',async()=>{
 const id=crypto.randomUUID(),url='https://example.com/slow-image';
 holdImages=true;
 const options=await context.newPage();await options.goto(`${extensionURL}/options.html`);
 await options.evaluate(async({id,url,data})=>{
   const state=(await chrome.storage.local.get('cairn_capture_v1')).cairn_capture_v1;
   const {keepImageFallback}=await import(chrome.runtime.getURL('images.mjs'));
   await keepImageFallback(id,0,'data:image/png;base64,'+data);
   state.queue.push({client_id:id,url,note:'',title:'慢网图片',binding:await (await import(chrome.runtime.getURL('config.mjs'))).tokenIdentity(state.settings.token),createdAt:Date.now(),attempts:0,nextAttemptAt:0,capture:{protocol:2,title:'慢网图片',language:'zh',text:'完整原文 ![图](cairn-image:0)',images:[{url:'',local:true}],media:[]}});
   state.lastResult={client_id:id,url,title:'慢网图片',status:'queued'};
   await chrome.storage.local.set({cairn_capture_v1:state});
 },{id,url,data:picture.toString('base64')});
 await options.reload();
 // Don't await the retry message: the image response deliberately remains open.
 await options.locator('#retry-all').click();
 await expect(options.locator('#queue')).toContainText('正文已同步');
 await expect.poll(()=>imageRequests.filter(k=>k===id+':0').length).toBe(1);
 const cdp=await context.newCDPSession(options);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');holdImages=false;
 await options.reload();await options.locator('#retry-all').click();await expect(options.locator('#pending-count')).toHaveText('0');
 expect(posts.filter(p=>p.client_id===id)).toHaveLength(1);expect(imageRequests.filter(k=>k===id+':0')).toHaveLength(1);
 await options.close();
});

test('upgrades a 0.4.0 base64 queue durably and retries only the missing image',async()=>{
 const id=crypto.randomUUID(),url='https://example.com/legacy-upload';failImage=1;
 const options=await context.newPage();await options.goto(`${extensionURL}/options.html`);
 await options.evaluate(async({id,url,data})=>{
   const state=(await chrome.storage.local.get('cairn_capture_v1')).cairn_capture_v1;
   state.queue.push({client_id:id,url,note:'旧备注',title:'旧队列',binding:await (await import(chrome.runtime.getURL('config.mjs'))).tokenIdentity(state.settings.token),createdAt:Date.now(),attempts:1,nextAttemptAt:0,capture:{title:'旧队列',language:'zh',text:'旧的完整原文 ![一](cairn-image:0) ![二](cairn-image:1)',images:[{content_type:'image/png',data},{content_type:'image/png',data}],media:[]}});
   state.lastResult={client_id:id,url,status:'queued'};await chrome.storage.local.set({cairn_capture_v1:state});
 },{id,url,data:picture.toString('base64')});
 await options.reload();await options.locator('#retry-all').click();
 await expect(options.locator('#queue')).toContainText('图片归档暂未完成');
 const saved=posts.find(p=>p.client_id===id);expect(saved.legacy_hash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(saved)).not.toContain(picture.toString('base64'));
 const cdp=await context.newCDPSession(options);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');failImage=null;
 await options.reload();await options.locator('#retry-all').click();await expect(options.locator('#pending-count')).toHaveText('0');
 expect(posts.filter(p=>p.client_id===id)).toHaveLength(1);expect(imageRequests.filter(k=>k===id+':0')).toHaveLength(1);expect(imageUploads.get(id+':1').bytes).toEqual(picture);
 await options.close();
});
