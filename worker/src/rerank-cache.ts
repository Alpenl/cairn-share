import type { Env } from "./index";
import { canonicalJSON } from "./domain";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const fail = (error: string, status = 400) => reply({ error }, status);
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type Item = { id: number; content_revision: number; body_revision: number; personal_revision: number; latest_decision_id: number; latest_entity_revision: number };
type Row = { cache_key: string; owner_token: string; status: string; items: string; answers: string; result_hash: string | null; expires_at: number };
const rowFields = "cache_key,owner_token,status,items,answers,result_hash,expires_at";
// Every canonical version affecting source, reading aids, filtering or human
// curation is compared inside the INSERT/UPDATE transaction, not just preflight.
const currentItems = `NOT EXISTS (SELECT 1 FROM json_each(?) item LEFT JOIN links l ON l.id=json_extract(item.value,'$.id')
  WHERE l.id IS NULL OR l.content_revision<>json_extract(item.value,'$.content_revision')
  OR l.app_body_revision<>json_extract(item.value,'$.body_revision') OR l.personal_revision<>json_extract(item.value,'$.personal_revision')
  OR COALESCE((SELECT MAX(d.id) FROM classification_decisions d WHERE d.link_id=l.id),0)<>json_extract(item.value,'$.latest_decision_id')
  OR COALESCE((SELECT e.revision FROM entity_states e WHERE e.link_id=l.id),0)<>json_extract(item.value,'$.latest_entity_revision'))`;
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2,"0")).join("");
}
function validItems(value: unknown): value is Item[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 || new Set(value.map(i=>i?.id)).size !== value.length) return false;
  const keys = ["id","content_revision","body_revision","personal_revision","latest_decision_id","latest_entity_revision"];
  return value.every(i => i && typeof i === "object" && Object.keys(i).length === keys.length && keys.every(k=>Number.isSafeInteger(i[k]) && i[k] >= (k==="id" ? 1 : 0)));
}
async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  try {
    const reader = request.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value}=await reader.read(); if(done)break;size+=value.length;if(size>262144){await reader.cancel();return null;}chunks.push(value); }
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    const body=JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body==="object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}
function validAnswers(value: unknown, items: Item[]): boolean {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const answers=value as Record<string,Record<string,unknown>>;
  return Object.keys(answers).length===items.length && items.every(item=>{
    const answer=answers[`rerank_${item.id}`];
    return answer && answer.type==="score" && typeof answer.score==="number" && Number.isFinite(answer.score) && answer.score>=0 && answer.score<=3;
  });
}
async function current(env: Env, items: string) { return Boolean(await env.DB.prepare(`SELECT ${currentItems} ok`).bind(items).first<number>("ok")); }
function view(row: Row, owned=false) {
  return { key: row.cache_key, status: row.status, owned, expires_at: row.expires_at, answers: JSON.parse(row.answers) };
}

// Fixed lifetime; hits never extend private-data retention. Each request/tick
// prunes at most 100 and the live cache has a hard 200-entry deployment cap.
export async function pruneRerankCache(env: { DB: D1Database }) {
  await env.DB.prepare("DELETE FROM rerank_cache WHERE cache_key IN (SELECT cache_key FROM rerank_cache WHERE expires_at<=? ORDER BY expires_at LIMIT 100)").bind(Date.now()).run();
}

export async function rerankCacheRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const match=path.match(/^\/api\/v2\/rerank-cache\/(claim|[a-f0-9]{64})(\/complete)?$/);
  if(!match)return null;
  if(match[1]==="claim" && !match[2]) {
    if(request.method!=="POST")return fail("method_not_allowed",405);
    const body=await bodyOf(request);
    if(!body || Object.keys(body).some(k=>!["owner_token","request_json","scope_hash","spec_hash","items"].includes(k)) ||
      !hex(body.owner_token) || !hex(body.scope_hash) || !hex(body.spec_hash) || !validItems(body.items) || typeof body.request_json!=="string" || body.request_json.length>131072) return fail("invalid_rerank_request");
    let wire: {model:string;state:unknown;questions:Record<string,{type:string}>};
    try { wire=JSON.parse(body.request_json); } catch {return fail("invalid_rerank_request");}
    if(!wire || wire.model!=="jev-1.13.0" || !wire.state || !wire.questions || Object.keys(wire.questions).length!==body.items.length ||
      !body.items.every(item=>wire.questions[`rerank_${item.id}`]?.type==="score"))return fail("invalid_rerank_request");
    const items=canonicalJSON(body.items);
    const key=await hash(canonicalJSON({request_json:body.request_json,scope_hash:body.scope_hash,spec_hash:body.spec_hash,items:body.items}));
    await pruneRerankCache(env);
    const now=Date.now();
    const insert=env.DB.prepare(`INSERT INTO rerank_cache(cache_key,owner_token,status,request_json,scope_hash,spec_hash,model,items,created_at,expires_at)
      SELECT ?,?,'pending',?,?,?,?,?,?,? WHERE ${currentItems} AND (SELECT COUNT(*) FROM rerank_cache)<200
      ON CONFLICT(cache_key) DO NOTHING`).bind(key,body.owner_token,body.request_json,body.scope_hash,body.spec_hash,wire.model,items,now,now+86400000,items);
    const refs=env.DB.prepare(`INSERT INTO rerank_cache_links(cache_key,link_id)
      SELECT ?,l.id FROM json_each(?) item JOIN links l ON l.id=json_extract(item.value,'$.id')
      WHERE EXISTS (SELECT 1 FROM rerank_cache WHERE cache_key=? AND owner_token=?) ON CONFLICT DO NOTHING`).bind(key,items,key,body.owner_token);
    // A bounded sweep may leave this particular expired key behind. Remove it
    // in the same transaction before claiming, never serve an expired hit.
    const expireKey=env.DB.prepare("DELETE FROM rerank_cache WHERE cache_key=? AND expires_at<=?").bind(key,now);
    const result=await env.DB.batch([expireKey,insert,refs]);
    const row=await env.DB.prepare(`SELECT ${rowFields} FROM rerank_cache WHERE cache_key=?`).bind(key).first<Row>();
    if(!await current(env,items))return fail("rerank_candidates_stale",409);
    if(!row)return fail("rerank_cache_full",429);
    return reply(view(row,Number(result[1].meta.changes)===1));
  }
  const row=await env.DB.prepare(`SELECT ${rowFields} FROM rerank_cache WHERE cache_key=?`).bind(match[1]).first<Row>();
  if(!row || row.expires_at<=Date.now())return fail("not_found",404);
  if(!match[2]) {
    if(request.method!=="GET")return fail("method_not_allowed",405);
    return await current(env,row.items) ? reply(view(row)) : fail("rerank_candidates_stale",409);
  }
  if(request.method!=="POST")return fail("method_not_allowed",405);
  const body=await bodyOf(request);
  if(!body || Object.keys(body).some(k=>!["owner_token","status","answers"].includes(k)) || body.owner_token!==row.owner_token ||
    typeof body.status!=="string" || !["completed","failed"].includes(body.status))return fail("invalid_rerank_completion",409);
  const items=JSON.parse(row.items) as Item[];
  if(body.status==="completed" && !validAnswers(body.answers,items))return fail("invalid_rerank_answers");
  if(body.status==="failed" && (body.answers===null || typeof body.answers!=="object" || Array.isArray(body.answers) || Object.keys(body.answers as object).length!==0))return fail("invalid_rerank_answers");
  const answers=canonicalJSON(body.answers);
  if(answers.length>32768)return fail("invalid_rerank_answers");
  const resultHash=await hash(canonicalJSON({status:body.status,answers:body.answers}));
  if(row.status!=="pending") {
    return row.result_hash===resultHash && await current(env,row.items) ? reply(view(row)) : fail("operation_conflict",409);
  }
  const now=Date.now();
  await env.DB.prepare(`UPDATE rerank_cache SET status=?,answers=?,result_hash=?,expires_at=MIN(expires_at,?)
    WHERE cache_key=? AND owner_token=? AND status='pending' AND expires_at>? AND ${currentItems}`)
    .bind(body.status,answers,resultHash,row.expires_at,row.cache_key,row.owner_token,now,row.items).run();
  const saved=await env.DB.prepare(`SELECT ${rowFields} FROM rerank_cache WHERE cache_key=?`).bind(row.cache_key).first<Row>();
  return saved?.result_hash===resultHash && await current(env,row.items) ? reply(view(saved)) : fail("rerank_candidates_stale",409);
}
