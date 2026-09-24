import type { Env } from "./index";
import { canonicalJSON } from "./domain";

// Daily caps for ordinary classification, separate from opt-in extensions.
// Every actual HTTP attempt (including each batch) reserves the pinned
// Jev 1.13 input ceiling. These are reservations, not observed token usage.
export const CLASSIFICATION_LIMITS = {
  max_calls_total: 20, max_calls_per_item: 5,
  max_tokens: 20 * 65536, max_tokens_per_item: 5 * 65536
};
export type ClassificationLimits = typeof CLASSIFICATION_LIMITS;
export function validClassificationLimits(value: unknown): value is ClassificationLimits {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4) return false;
  const limits = value as Record<string, unknown>;
  return Object.entries(CLASSIFICATION_LIMITS).every(([key, max]) => Number.isSafeInteger(limits[key]) && Number(limits[key]) >= 1 && Number(limits[key]) <= max);
}
export function classificationWindow() {
  const now = new Date().toISOString();
  const start = now.slice(0, 10) + "T00:00:00.000Z";
  return { now, start, end: new Date(Date.parse(start) + 86400000).toISOString() };
}
export async function classificationBudgetAvailable(env: Env, limits: ClassificationLimits): Promise<boolean> {
  const { start, end } = classificationWindow();
  const row = await env.DB.prepare(`SELECT COUNT(*) calls,COALESCE(SUM(json_extract(units,'$.tokens')),0) tokens
    FROM budget_ledger WHERE scope='classification_global' AND created_at>=? AND created_at<?`)
    .bind(start, end).first<{calls:number;tokens:number}>();
  return Boolean(row && row.calls < limits.max_calls_total && row.tokens + 65536 <= limits.max_tokens);
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const fail = (error: string, status = 400) => reply({error}, status);
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const leaseGuard = `EXISTS (SELECT 1 FROM classification_jobs j JOIN links l ON l.id=j.link_id
  JOIN classification_target_state t ON t.id=1 JOIN evidence_snapshots e ON e.id=j.evidence_snapshot_id
  WHERE j.link_id=? AND j.status='processing' AND j.lease_token=? AND j.lease_until>?
  AND j.revision=? AND j.input_revision=? AND j.target_generation=? AND j.target_generation=t.generation
  AND j.spec_id=? AND j.content_revision=? AND j.content_revision=l.content_revision
  AND j.evidence_snapshot_id=? AND j.evidence_hash=? AND j.requested_model=?
  AND e.link_id=j.link_id AND e.content_revision=j.content_revision AND e.content_hash=j.evidence_hash)`;

// A lost response never re-grants and never refunds the committed reservation.
export async function classificationBudgetRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/v2/classification-budget/reserve") return null;
  if (request.method !== "POST") return fail("method_not_allowed",405);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("invalid_json");
  let body: Record<string, unknown>;
  try {
    const reader=request.body?.getReader(); if(!reader)return fail("invalid_json");
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return fail("request_too_large",413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    body=JSON.parse(new TextDecoder().decode(bytes));
  } catch {return fail("invalid_json");}
  const keys=["operation_key","link_id","lease_token","revision","input_revision","target_generation","spec_id","content_revision","evidence_snapshot_id","evidence_hash","model","request_hash","tokens","limits"];
  if(!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).length!==keys.length || Object.keys(body).some(k=>!keys.includes(k)) ||
    !hex(body.operation_key) || !hex(body.request_hash) || typeof body.lease_token!=="string" || !body.lease_token || body.lease_token.length>100 ||
    !["link_id","revision","input_revision","content_revision","evidence_snapshot_id"].every(k=>positive(body[k])) ||
    !Number.isSafeInteger(body.target_generation) || Number(body.target_generation)<0 ||
    typeof body.spec_id!=="string" || !body.spec_id || body.spec_id.length>100 || typeof body.evidence_hash!=="string" || !body.evidence_hash || body.evidence_hash.length>100 ||
    body.model!=="jev-1.13.0" || body.tokens!==65536 || !validClassificationLimits(body.limits))return fail("invalid_reservation");
  const limits=body.limits;
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalJSON(body)));
  const payloadHash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
  const operationKey=`classification:${body.operation_key}`;
  const old=await env.DB.prepare("SELECT units FROM budget_ledger WHERE operation_key=?").bind(operationKey).first<{units:string}>();
  if(old)return JSON.parse(old.units).payload_hash===payloadHash ? reply({granted:false,reason:"already_reserved"}) : fail("operation_conflict",409);
  const {now,start,end}=classificationWindow();
  const bindings=[body.link_id,body.lease_token,now,body.revision,body.input_revision,body.target_generation,body.spec_id,body.content_revision,body.evidence_snapshot_id,body.evidence_hash,body.model];
  // Global rows contain no bookmark id, lease, request text or source material.
  const units=canonicalJSON({calls:1,tokens:65536,payload_hash:payloadHash});
  const global=env.DB.prepare(`INSERT INTO budget_ledger(scope,link_id,units,operation_key,created_at)
    SELECT 'classification_global',NULL,?,?,? WHERE ${leaseGuard}
    AND (SELECT COUNT(*) FROM budget_ledger WHERE scope='classification_global' AND created_at>=? AND created_at<?) < ?
    AND (SELECT COALESCE(SUM(json_extract(units,'$.tokens')),0) FROM budget_ledger WHERE scope='classification_global' AND created_at>=? AND created_at<?)+65536 <= ?
    AND (SELECT COUNT(*) FROM budget_ledger WHERE scope='classification_item' AND link_id=? AND created_at>=? AND created_at<?) < ?
    AND (SELECT COALESCE(SUM(json_extract(units,'$.tokens')),0) FROM budget_ledger WHERE scope='classification_item' AND link_id=? AND created_at>=? AND created_at<?)+65536 <= ?
    ON CONFLICT(operation_key) DO NOTHING`).bind(units,operationKey,now,...bindings,start,end,limits.max_calls_total,start,end,limits.max_tokens,body.link_id,start,end,limits.max_calls_per_item,body.link_id,start,end,limits.max_tokens_per_item);
  const item=env.DB.prepare(`INSERT INTO budget_ledger(scope,link_id,units,operation_key,created_at)
    SELECT 'classification_item',?,?,?,? WHERE EXISTS(SELECT 1 FROM budget_ledger WHERE operation_key=? AND json_extract(units,'$.payload_hash')=?)
    AND EXISTS(SELECT 1 FROM links WHERE id=?) ON CONFLICT(operation_key) DO NOTHING`)
    .bind(body.link_id,units,operationKey+":item",now,operationKey,payloadHash,body.link_id);
  const result=await env.DB.batch([global,item]);
  const stored=await env.DB.prepare("SELECT units FROM budget_ledger WHERE operation_key=?").bind(operationKey).first<{units:string}>();
  if(stored && JSON.parse(stored.units).payload_hash!==payloadHash)return fail("operation_conflict",409);
  if(Number(result[0].meta.changes)===1)return reply({granted:true,reason:"reserved"});
  if(stored)return reply({granted:false,reason:"already_reserved"});
  if(!await env.DB.prepare(`SELECT ${leaseGuard} ok`).bind(...bindings).first<number>("ok"))return fail("lease_expired",409);
  return reply({granted:false,reason:"budget_exhausted"});
}
