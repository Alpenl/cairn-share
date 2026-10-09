import {registerMedia,validMediaDeclarations} from './archived-media';
import type { Env } from './index';
import { browserCapture, digest } from './browser-capture';
import { readBoundedJSON } from './json-body';

const types: Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif'};
const MAX_IMAGE = 16 * 1024 * 1024;
const reply = (body: unknown, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'private, no-store'}});
type ImageRow = {capture_id:string;ordinal:number;link_id:number;digest:string|null;size:number|null;content_type:string|null;r2_key:string|null;status:string};

export async function captureUploads(request:Request, env:Env, path:string):Promise<Response> {
    if (path === '/api/captures/v2') return request.method === 'POST' ? browserCapture(request,env,true) : reply({error:'method_not_allowed'},405);
    const route = path.match(/^\/api\/captures\/v2\/([a-f0-9-]{36})(?:\/(?:images\/(\d+)|(media)))?$/i);
    if (!route) return reply({error:'not_found'},404);
    const id=route[1];
    const receipt=await env.DB.prepare(`SELECT b.*,s.request_json,l.last_capture_id,l.note AS stored_note,l.url AS stored_url
      FROM browser_captures b JOIN capture_upload_sessions s ON s.client_id=b.client_id LEFT JOIN links l ON l.id=b.link_id WHERE b.client_id=?`).bind(id).first<any>();
    if (!receipt) return reply({error:'not_found'},404);
    if (!receipt.stored_url) return reply({error:'capture_deleted'},410);
    if (receipt.completed && receipt.last_capture_id!==id) return reply({error:'media_stale'},409);
    const body=JSON.parse(receipt.request_json);
    if (route[3]==='media') {
        if (request.method!=='POST') return reply({error:'method_not_allowed'},405);
        if (!receipt.completed) return reply({error:'capture_incomplete'},409);
        let media:any;try{media=await readBoundedJSON(request,160000);}catch{return reply({error:'invalid_media'},400);}
        if (!Array.isArray(media) || !validMediaDeclarations(media)) return reply({error:'invalid_media'},400);
        const value=JSON.stringify(media);
        await env.DB.prepare('UPDATE capture_upload_sessions SET media_json=? WHERE client_id=? AND media_json IS NULL AND EXISTS(SELECT 1 FROM links WHERE id=? AND last_capture_id=?)').bind(value,id,receipt.link_id,id).run();
        if (await env.DB.prepare('SELECT media_json FROM capture_upload_sessions WHERE client_id=?').bind(id).first('media_json')!==value) return reply({error:'media_conflict'},409);
        await registerMedia(env,id,media);return reply({status:'ready'});
    }
    if (route[2]===undefined) {
        if (request.method!=='GET') return reply({error:'method_not_allowed'},405);
        const images=await env.DB.prepare('SELECT ordinal,status,size FROM capture_image_uploads WHERE capture_id=? ORDER BY ordinal').bind(id).all();
        // A completed legacy receipt already includes every image. Its original
        // UUID/hash is retained when a 0.4.0 queue is upgraded after a lost ACK.
        const ready=images.results.length ? images.results.filter(i=>i.status==='ready').map(i=>i.ordinal) : receipt.completed ? body.capture.images.map((_:unknown,i:number)=>i) : [];
        return reply({id:receipt.link_id,url:body.url,note:body.note,completed:!!receipt.completed,images_ready:ready,
            capture_result:{action:receipt.was_existing?'updated':'created',images_saved:ready.length,media_count:body.capture.media?.length||0}});
    }
    if (!receipt.completed) return reply({error:'capture_incomplete'},409);
    const ordinal=Number(route[2]);
    const row=await env.DB.prepare('SELECT * FROM capture_image_uploads WHERE capture_id=? AND ordinal=?').bind(id,ordinal).first<ImageRow>();
    if (!row) return reply({error:'not_found'},404);
    if (request.method==='POST') {
        let b:any;try{b=await readBoundedJSON(request,2048);}catch{return reply({error:'invalid_image'},400);}
        if (!b || !types[b.content_type] || !Number.isSafeInteger(b.size) || b.size<1 || b.size>MAX_IMAGE || !/^[a-f0-9]{64}$/.test(b.digest||'')) return reply({error:'invalid_image'},400);
        if (row.digest && (row.digest!==b.digest || row.size!==b.size || row.content_type!==b.content_type)) return reply({error:'media_conflict'},409);
        if (row.status==='ready') return reply({status:'ready'});
        const key=`enrichment/${row.link_id}/${b.digest}.${types[b.content_type]}`;
        await env.DB.prepare('UPDATE capture_image_uploads SET digest=?,size=?,content_type=?,r2_key=? WHERE capture_id=? AND ordinal=? AND digest IS NULL')
            .bind(b.digest,b.size,b.content_type,key,id,ordinal).run();
        const current=await env.DB.prepare('SELECT * FROM capture_image_uploads WHERE capture_id=? AND ordinal=?').bind(id,ordinal).first<ImageRow>();
        if (!current || current.digest!==b.digest || current.size!==b.size || current.content_type!==b.content_type) return reply({error:'media_conflict'},409);
        // Content-addressed objects include images left by an interrupted 0.4.0
        // capture; reuse them without downloading or uploading the bytes again.
        const object=await env.ENRICHMENT_IMAGES.head(key);
        if (object && object.size===b.size) return finishImage(env,current);
        return reply({status:'pending'});
    }
    if (request.method==='PUT') {
        if (!row.digest || !row.size || !row.content_type || !row.r2_key || !request.body) return reply({error:'invalid_image'},400);
        if (row.status==='ready') return reply({status:'ready'});
        const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
        for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>row.size){await reader.cancel();return reply({error:'invalid_image'},400);}chunks.push(value);}
        if(size!==row.size) return reply({error:'invalid_image'},400);
        const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
        if(await digest(bytes)!==row.digest) return reply({error:'media_conflict'},409);
        await env.ENRICHMENT_IMAGES.put(row.r2_key,bytes,{httpMetadata:{contentType:row.content_type}});
        return finishImage(env,row);
    }
    return reply({error:'method_not_allowed'},405);
}

async function finishImage(env:Env,row:ImageRow):Promise<Response> {
    // SQL json_set updates one slot atomically; three simultaneous image ACKs
    // cannot lose one another's references. The capture guard rejects old tabs.
    const ref=JSON.stringify({key:row.r2_key,content_type:row.content_type});
    await env.DB.batch([
        env.DB.prepare(`UPDATE links SET images=json_set(images,?,json(?)) WHERE id=? AND last_capture_id=?
          AND EXISTS(SELECT 1 FROM capture_image_uploads WHERE capture_id=? AND ordinal=? AND status='pending')`)
          .bind(`$[${row.ordinal}]`,ref,row.link_id,row.capture_id,row.capture_id,row.ordinal),
        env.DB.prepare(`UPDATE capture_image_uploads SET status='ready' WHERE capture_id=? AND ordinal=? AND EXISTS
          (SELECT 1 FROM links WHERE id=? AND last_capture_id=? AND json_extract(images,?)=?)`)
          .bind(row.capture_id,row.ordinal,row.link_id,row.capture_id,`$[${row.ordinal}].key`,row.r2_key),
        env.DB.prepare("UPDATE links SET enrichment_next_retry_at=NULL WHERE id=? AND last_capture_id=? AND enrichment_next_retry_at='9999-12-31T00:00:00Z' AND NOT EXISTS(SELECT 1 FROM capture_image_uploads WHERE capture_id=? AND status<>'ready')").bind(row.link_id,row.capture_id,row.capture_id)
    ]);
    const current=await env.DB.prepare('SELECT id FROM links WHERE id=? AND last_capture_id=?').bind(row.link_id,row.capture_id).first();
    return current ? reply({status:'ready'}) : reply({error:'media_stale'},409);
}
