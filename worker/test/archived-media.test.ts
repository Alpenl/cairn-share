import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import worker from '../src/index';
const bindings={...env,CAIRN_API_TOKEN:'app-test',CAIRN_ENRICHER_TOKEN:'internal-test'};
const call=(path:string,method='GET',body?:unknown,extra:Record<string,string>={})=>worker.fetch(new Request('https://share.alpenl.com'+path,{method,headers:{Authorization:'Bearer app-test','Content-Type':'application/json',...extra},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})}),bindings);
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('persists actual media bytes, resumes idempotently, supports ranges and rejects deleted ownership',async()=>{
 const saved:any=await (await call('/api/captures','POST',{url:'https://example.com/video',note:'',client_id:crypto.randomUUID(),capture:{title:'Movie',language:'en',text:'Article with a video.',images:[],media:[{kind:'video',title:'Movie',url:'https://cdn.example.com/movie.mp4'}]}})).json();
 const list:any=await (await call(`/api/links/${saved.id}/media`)).json();expect(list.items).toHaveLength(1);const id=list.items[0].id;
 const bytes=new TextEncoder().encode('0000ftypisom-sample-media-file');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const init={content_type:'video/mp4',size:bytes.length,digest};
 expect((await call(`/api/media/uploads/${id}`,'POST',init)).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/1`,'PUT',bytes)).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/1`,'PUT',bytes)).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/complete`,'POST',{})).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/complete`,'POST',{})).status).toBe(200);
 const file=await call(`/api/media/${id}`);expect(file.status).toBe(200);expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
 const range=await call(`/api/media/${id}`,'GET',undefined,{Range:'bytes=4-7'});expect(range.status).toBe(206);expect(new TextDecoder().decode(await range.arrayBuffer())).toBe('ftyp');expect(range.headers.get('Content-Range')).toBe(`bytes 4-7/${bytes.length}`);
 for(const bad of ['bytes=999-','bytes=9-4','bytes=-0','bytes=1-2,4-5'])expect((await call(`/api/media/${id}`,'GET',undefined,{Range:bad})).status).toBe(416);
 const privateRead=await worker.fetch(new Request(`https://share.alpenl.com/api/media/${id}`),bindings);expect(privateRead.status).toBe(401);
 await env.DB.prepare('DELETE FROM links WHERE id=?').bind(saved.id).run();
 expect((await call(`/api/media/${id}`)).status).toBe(404);expect((await call(`/api/media/uploads/${id}`,'POST',init)).status).toBe(409);
});

it('restarts expired multipart sessions and rejects media from a replaced capture',async()=>{
 const url='https://example.com/resume',client_id=crypto.randomUUID();
 const body={url,note:'',client_id,capture:{title:'Resume',language:'en',text:'Original video.',images:[],media:[{kind:'video',title:'Movie',url:'https://cdn.example.com/video.mp4'}]}};
 const saved:any=await (await call('/api/captures','POST',body)).json();
 const list:any=await (await call(`/api/links/${saved.id}/media`)).json();const id=list.items[0].id;
 const bytes=new Uint8Array(8*1024*1024+37).fill(7);
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const init={content_type:'video/mp4',size:bytes.length,digest};
 expect((await call(`/api/media/uploads/${id}`,'POST',init)).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/1`,'PUT',bytes.slice(0,8*1024*1024))).status).toBe(200);
 const resumed:any=await (await call(`/api/media/uploads/${id}`,'POST',init)).json();expect(resumed.parts).toHaveLength(1);
 await env.DB.prepare("UPDATE archived_media SET upload_started_at='2000-01-01' WHERE id=?").bind(id).run();
 const reset:any=await (await call(`/api/media/uploads/${id}`,'POST',init)).json();expect(reset.parts).toHaveLength(0);
 expect((await call(`/api/media/uploads/${id}/1`,'PUT',bytes.slice(0,8*1024*1024))).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/2`,'PUT',bytes.slice(8*1024*1024))).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/complete`,'POST',{})).status).toBe(200);
 const returned=await (await call(`/api/media/${id}`)).arrayBuffer();expect(returned.byteLength).toBe(bytes.length);
 expect([...new Uint8Array(await crypto.subtle.digest('SHA-256',returned))].map(b=>b.toString(16).padStart(2,'0')).join('')).toBe(digest);
 expect((await call('/api/captures','POST',{...body,client_id:crypto.randomUUID(),capture:{...body.capture,text:'New capture.'}})).status).toBe(201);
 expect((await call(`/api/media/${id}`)).status).toBe(404);expect((await call(`/api/media/uploads/${id}`,'POST',init)).status).toBe(409);
},30000);


it('registers all 60 media items and uploads a 257 MiB file with resumable parts',async()=>{
 const media=Array.from({length:60},(_,i)=>({kind:'video',title:`Movie ${i}`,url:`https://cdn.example.com/${i}.mp4`}));
 const savedResponse=await call('/api/captures','POST',{url:'https://example.com/large',note:'',client_id:crypto.randomUUID(),capture:{title:'Large movie',language:'en',text:'Article with many movies.',images:[],media}});
 expect(savedResponse.status).toBe(201);const saved:any=await savedResponse.json();
 const list:any=await (await call(`/api/links/${saved.id}/media`)).json();expect(list.items).toHaveLength(60);const id=list.items[0].id;
 const size=257*1024*1024,part=new Uint8Array(8*1024*1024).fill(42);
 const init={content_type:'video/mp4',size,digest:'a'.repeat(64)};
 for(const size of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])expect((await call(`/api/media/uploads/${id}`,'POST',{...init,size})).status).toBe(400);
 const started:any=await (await call(`/api/media/uploads/${id}`,'POST',init)).json();expect(started.chunk_size).toBe(part.length);
 expect((await call(`/api/media/uploads/${id}/1`,'PUT',part)).status).toBe(200);
 const resumed:any=await (await call(`/api/media/uploads/${id}`,'POST',init)).json();expect(resumed.parts).toHaveLength(1);
 expect((await call(`/api/media/uploads/${id}/1`,'PUT',part)).status).toBe(200);
 for(let i=2;i<=33;i++)expect((await call(`/api/media/uploads/${id}/${i}`,'PUT',i===33?part.slice(0,1024*1024):part)).status).toBe(200);
 expect((await call(`/api/media/uploads/${id}/complete`,'POST',{})).status).toBe(200);
 const range=await call(`/api/media/${id}`,'GET',undefined,{Range:`bytes=${256*1024*1024-3}-${256*1024*1024+3}`});
 expect(range.status).toBe(206);expect(range.headers.get('Content-Range')).toBe(`bytes ${256*1024*1024-3}-${256*1024*1024+3}/${size}`);expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array(7).fill(42));
 const head=await call(`/api/media/${id}`,'HEAD');expect(head.headers.get('Content-Length')).toBe(String(size));
 const row:any=await env.DB.prepare('SELECT original_text FROM links WHERE id=?').bind(saved.id).first();expect(row.original_text).toBe('Article with many movies.');
},120000);
