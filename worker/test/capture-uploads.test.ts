import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import worker from '../src/index';
import {digest} from '../src/browser-capture';
import {canonicalJSON} from '../src/domain';

const bindings={...env,CAIRN_API_TOKEN:'app-test'};
const call=(path:string,body?:unknown,method=body===undefined?'GET':'POST',token='app-test')=>worker.fetch(new Request('https://test'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})}),bindings);
const make=()=>({url:'https://x.com/person/status/123',note:'我的备注',client_id:crypto.randomUUID(),capture:{protocol:2,title:'图文',language:'zh',text:'# 标题\n完整原文\n![一](cairn-image:0)\n![二](cairn-image:1)',images:[{url:'https://cdn.test/1.jpg'},{url:'https://cdn.test/2.jpg'}],media:[]}});
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('commits text before any binary; concurrent images preserve both references and retry skips ready bytes',async()=>{
 const body=make(),base=`/api/captures/v2/${body.client_id}`;
 expect((await call('/api/captures/v2',body,undefined,'wrong')).status).toBe(401);
 const start=await call('/api/captures/v2',body);expect(start.status).toBe(201);const saved:any=await start.json();
 const text:any=await env.DB.prepare('SELECT original_text,images,enrichment_status,app_body_revision FROM links WHERE id=?').bind(saved.id).first();
 expect(text.original_text).toBe(body.capture.text);expect(text.enrichment_status).toBe('pending');
 expect((await env.ENRICHMENT_IMAGES.list()).objects).toHaveLength(0);
 expect((await (await call(base)).json() as any).images_ready).toEqual([]);
 const binaries=[new Uint8Array([1,2,3]),new Uint8Array([4,5,6,7])];
 await Promise.all(binaries.map(async(bytes,i)=>{
   expect((await call(`${base}/images/${i}`,{digest:await digest(bytes),size:bytes.length,content_type:'image/png'})).status).toBe(200);
   expect((await call(`${base}/images/${i}`,bytes,'PUT')).status).toBe(200);
 }));
 const complete:any=await (await call(base)).json();expect(complete.images_ready).toEqual([0,1]);
 const after:any=await env.DB.prepare('SELECT images,app_body_revision FROM links WHERE id=?').bind(saved.id).first();
 for(const [i,ref] of JSON.parse(after.images).entries())expect(new Uint8Array(await (await env.ENRICHMENT_IMAGES.get(ref.key))!.arrayBuffer())).toEqual(binaries[i]);
 expect(after.app_body_revision).toBeGreaterThan(text.app_body_revision);
 expect((await call('/api/captures/v2',body)).status).toBe(201);
 expect((await call(`${base}/images/0`,binaries[0],'PUT')).status).toBe(200);
 expect(await env.DB.prepare('SELECT app_body_revision FROM links WHERE id=?').bind(saved.id).first('app_body_revision')).toBe(after.app_body_revision);
});
it('reuses already uploaded images by digest, including partial legacy captures',async()=>{
 const body=make(),base=`/api/captures/v2/${body.client_id}`;
 const bytes=new Uint8Array([1,2,3]),hash=await digest(bytes);
 const saved:any=await (await call('/api/captures/v2',body)).json();
 await env.ENRICHMENT_IMAGES.put(`enrichment/${saved.id}/${hash}.png`,bytes);
 expect(await (await call(`${base}/images/0`,{digest:hash,size:3,content_type:'image/png'})).json()).toEqual({status:'ready'});
 expect((await (await call(base)).json() as any).images_ready).toEqual([0]);
});
it('rejects changed manifests, corrupt bytes, stale recaptures and deleted bookmarks',async()=>{
 const body=make(),base=`/api/captures/v2/${body.client_id}`;
 const saved:any=await (await call('/api/captures/v2',body)).json();
 expect((await call('/api/captures/v2',{...body,note:'changed'})).status).toBe(409);
 await call(`${base}/images/0`,{digest:await digest(new Uint8Array([1])),size:1,content_type:'image/png'});
 expect((await call(`${base}/images/0`,new Uint8Array([2]),'PUT')).status).toBe(409);
 const next={...body,client_id:crypto.randomUUID(),capture:{...body.capture,text:'重新采集'}};
 const updated:any=await (await call('/api/captures/v2',next)).json();expect(updated.id).toBe(saved.id);
 expect((await call(`${base}/images/0`,new Uint8Array([1]),'PUT')).status).toBe(409);
 await env.DB.prepare('DELETE FROM links WHERE id=?').bind(saved.id).run();
 expect((await call(`/api/captures/v2/${next.client_id}`)).status).toBe(410);
 expect(await env.DB.prepare('SELECT request_json FROM capture_upload_sessions WHERE client_id=?').bind(next.client_id).first('request_json')).toBe('{}');
 expect((await call('/api/captures/v2',next)).status).toBe(410);
});
it('upgrades a legacy interrupted receipt without creating another bookmark or requiring the old large upload',async()=>{
 const body=make();const old={...body,capture:{...body.capture,protocol:undefined,images:[{content_type:'image/png',data:'AQID'}]}};
 // Match the on-wire v0.4.0 JSON (undefined fields do not travel).
 const legacy=JSON.parse(JSON.stringify(old)),hash=await digest(canonicalJSON(legacy));
 await env.DB.prepare("INSERT INTO links(url,note,created_at,client_id,enrichment_status,url_identity) VALUES(?,?,'2026-10-09',?,'completed','https://x.com/i/web/status/123')").bind(body.url,body.note,body.client_id).run();
 await env.DB.prepare("INSERT INTO browser_captures(client_id,link_id,payload_hash,created_at,expected_revision,expected_body_revision) SELECT ?,id,?,'2026-10-09',content_revision,app_body_revision FROM links").bind(body.client_id,hash).run();
 const v2={...body,legacy_hash:hash,capture:{...body.capture,images:[{url:'',local:true}]}};
 expect((await call('/api/captures/v2',v2)).status).toBe(201);
 const replay:any=await (await call('/api/captures/v2',v2)).json();expect(replay.capture_result.images_saved).toBe(0);
 expect(await env.DB.prepare('SELECT count(*) AS n FROM links').first('n')).toBe(1);
 expect((await (await call(`/api/captures/v2/${body.client_id}`)).json() as any).completed).toBe(true);
});
it('registers discovered videos after text and rejects changing their manifest',async()=>{
 const body=make();await call('/api/captures/v2',body);
 const path=`/api/captures/v2/${body.client_id}/media`,media=[{kind:'video',url:'https://cdn.test/v.mp4',title:'视频'}];
 expect((await call(path,media)).status).toBe(200);expect((await call(path,media)).status).toBe(200);
 expect((await call(path,[])).status).toBe(409);
 expect(await env.DB.prepare('SELECT count(*) AS n FROM archived_media').first('n')).toBe(1);
});
