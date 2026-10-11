import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import worker from '../src/index';

const call=(path:string,body?:unknown,token='app-test')=>worker.fetch(new Request('https://test'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{...env,CAIRN_API_TOKEN:'app-test'});
const pending='/api/captures/v2/pending';
const create=async(url='https://example.org/article?keep=1#body')=>(await (await call('/api/links',{url,note:'手机备注',client_id:crypto.randomUUID()})).json()) as any;
const target=async(id:number)=>(await (await call(`${pending}/${id}`)).json() as any).item;
const capture=(item:any)=>({url:item.url,note:'',client_id:crypto.randomUUID(),target:{id:item.id,content_revision:item.content_revision,app_body_revision:item.app_body_revision},capture:{protocol:2,title:'正文',language:'zh',text:'浏览器采集的完整原文',images:[],media:[]}});
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});

it('pages every missing source in a fixed ID range, excluding filled and dropped bookmarks',async()=>{
  await env.DB.batch(Array.from({length:105},(_,i)=>env.DB.prepare("INSERT INTO links(url,note,created_at) VALUES(?,'','2026-10-10')").bind(`https://example.org/${i}`)));
  await env.DB.prepare("UPDATE links SET original_text='已有正文' WHERE id=2").run();
  await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=3").run();
  expect((await call(pending,undefined,'wrong')).status).toBe(401);
  const page:any=await (await call(pending)).json();
  expect(page.batch_version).toBe(1);expect(page.items).toHaveLength(100);expect(page.upper).toBe(105);
  expect(page.items.some((t:any)=>[2,3].includes(t.id))).toBe(false);
  expect(page.items[0].original_text).toBeUndefined();
  await create('https://example.org/new-after-scan');
  const last:any=await (await call(`${pending}?after=${page.next_after}&upper=${page.upper}`)).json();
  expect(last.items).toHaveLength(3);expect(last.next_after).toBeNull();
  expect((await call(`${pending}?after=-1`)).status).toBe(400);
  expect((await call(pending,{})).status).toBe(405);
  expect(await target(2)).toBeNull();
});

it('fills the exact original ID, preserving mobile note and replaying the same receipt',async()=>{
  const link=await create();const body=capture(await target(link.id));
  const res=await call('/api/captures/v2',body);expect(res.status).toBe(201);
  const saved:any=await res.json();expect(saved.id).toBe(link.id);expect(saved.capture_result.action).toBe('updated');
  const row:any=await env.DB.prepare('SELECT note,url,original_text FROM links WHERE id=?').bind(link.id).first();
  expect(row).toEqual({note:'手机备注',url:link.url,original_text:body.capture.text});
  expect(await target(link.id)).toBeNull();
  expect((await call('/api/captures/v2',body)).status).toBe(201);
  expect(await env.DB.prepare('SELECT count(*) n FROM links').first('n')).toBe(1);
});

it('never recreates deleted links or overwrites a changed, filled or dropped target',async()=>{
  const link=await create();const item=await target(link.id);const body=capture(item);
  await env.DB.prepare("UPDATE links SET original_text='另一个设备的正文' WHERE id=?").bind(link.id).run();
  expect((await call('/api/captures/v2',body)).status).toBe(409);
  expect(await env.DB.prepare('SELECT original_text FROM links WHERE id=?').bind(link.id).first('original_text')).toBe('另一个设备的正文');
  const drop=await create('https://example.org/drop');const dropped=capture(await target(drop.id));
  await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=?").bind(drop.id).run();
  expect((await call('/api/captures/v2',dropped)).status).toBe(409);
  await env.DB.prepare('DELETE FROM links WHERE id=?').bind(link.id).run();
  expect((await call('/api/captures/v2',body)).status).toBe(410);
  expect(await env.DB.prepare('SELECT count(*) n FROM links WHERE url=?').bind(body.url).first('n')).toBe(0);
  expect((await call('/api/captures/v2',{...dropped,target:{...dropped.target,id:'1'}})).status).toBe(400);
});

it('rechecks the missing-source condition after a receipt was reserved',async()=>{
  const link=await create();const body=capture(await target(link.id));
  // Simulate an interrupted upload after reserving its target, before applying text.
  const {digest}=await import('../src/browser-capture');const {canonicalJSON}=await import('../src/domain');
  await env.DB.prepare(`INSERT INTO browser_captures(client_id,link_id,payload_hash,created_at,expected_revision,expected_body_revision,was_existing)
    VALUES(?,?,?,'2026-10-10',?,?,1)`).bind(body.client_id,link.id,await digest(canonicalJSON(body)),body.target.content_revision,body.target.app_body_revision).run();
  await env.DB.prepare("UPDATE links SET curation_status='drop' WHERE id=?").bind(link.id).run();
  expect((await call('/api/captures/v2',body)).status).toBe(409);
  expect(await env.DB.prepare('SELECT original_text FROM links WHERE id=?').bind(link.id).first('original_text')).toBeNull();
});
