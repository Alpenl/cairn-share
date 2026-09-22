import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

type Bindings = Parameters<typeof worker.fetch>[1];
const bindings = (): Bindings => ({ DB: env.DB, ENRICHMENT_IMAGES: env.ENRICHMENT_IMAGES,
  CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
const keyFor = (id: number) => `enrichment/${id}/${"a".repeat(64)}.png`;
async function request(path: string, method = "GET", body?: unknown, token = "app", e = bindings()) {
  return worker.fetch(new Request(`https://privacy.example/api/${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }), e);
}
async function create() {
  const r = await request("links", "POST", { url: "https://x.com/privacy/status/123", note: "synthetic private note" });
  expect(r.status).toBe(201);
  return (await r.json() as {id: number}).id;
}
function bucket(overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(env.ENRICHMENT_IMAGES, { get(target, property) {
    const custom = Reflect.get(overrides, property);
    if (custom !== undefined) return custom;
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());

it("HTTP deletion removes R2 history and link-scoped budgets without touching other links", async () => {
  const id = await create(); const other = await create();
  await env.ENRICHMENT_IMAGES.put(keyFor(id), "private image");
  await env.ENRICHMENT_IMAGES.put(`enrichment/${id}/historical-unreferenced`, "old private image");
  await env.ENRICHMENT_IMAGES.put(keyFor(other), "keep");
  for (const link of [id, other]) await env.DB.prepare("INSERT INTO budget_ledger(scope,link_id,units,operation_key,created_at) VALUES ('evidence',?,'{}',?,?)")
    .bind(link, `op-${link}`, new Date().toISOString()).run();
  expect((await request(`links/${id}`, "DELETE")).status).toBe(204);
  expect((await env.ENRICHMENT_IMAGES.list({prefix:`enrichment/${id}/`})).objects).toHaveLength(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE link_id=?").bind(id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE link_id=?").bind(other).first("n")).toBe(1);
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(other))).not.toBeNull();
});

it("does not serve an orphaned image even for a conditional GET", async () => {
  const id = await create(); const key = keyFor(id);
  const object = await env.ENRICHMENT_IMAGES.put(key, "body");
  await env.DB.prepare("DELETE FROM links WHERE id=?").bind(id).run();
  const r = await worker.fetch(new Request(`https://privacy.example/api/images/${key}`, {
    headers: {Authorization:"Bearer app", "If-None-Match": object!.httpEtag} }), bindings());
  expect(r.status).toBe(404);
});

it("a put completing after deletion cannot recreate a readable or retained image", async () => {
  const id = await create();
  const claim = await (await request(`enrichment/jobs/${id}/claim`, "POST", undefined, "internal")).json() as {lease_token:string};
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new Uint8Array([1,2]), {headers:{"Content-Type":"image/png"}}));
  const e = bindings();
  e.ENRICHMENT_IMAGES = bucket({ put: async (...args: Parameters<R2Bucket["put"]>) => {
    expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
    return env.ENRICHMENT_IMAGES.put(...args);
  } });
  const r = await request(`enrichment/jobs/${id}/images`, "POST", {lease_token:claim.lease_token,image_urls:["https://pbs.twimg.com/media/race.png"]}, "internal", e);
  expect(r.status).toBe(409);
  expect((await env.ENRICHMENT_IMAGES.list({prefix:`enrichment/${id}/`})).objects).toHaveLength(0);
});


it("retains a durable retry after R2 failure; missing authentication cannot delete", async () => {
  const id = await create(); const key = keyFor(id);
  await env.ENRICHMENT_IMAGES.put(key,"private");
  expect((await request(`links/${id}`,"DELETE",undefined,"wrong")).status).toBe(401);
  expect((await request(`links/${id}`,"DELETE",undefined,"internal")).status).toBe(401);
  const e=bindings();e.ENRICHMENT_IMAGES=bucket({delete:async()=>{throw new Error("injected storage outage");}});
  const failed=await request(`links/${id}`,"DELETE",undefined,"app",e);
  expect(failed.status).toBe(503);expect(failed.headers.get("Retry-After")).toBe("300");
  expect(await env.DB.prepare("SELECT id FROM links WHERE id=?").bind(id).first()).toBeNull();
  expect(await env.DB.prepare("SELECT link_id FROM privacy_deletions WHERE link_id=?").bind(id).first()).not.toBeNull();
  expect((await request(`images/${key}`)).status).toBe(404);
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
  expect((await request("links/99999","DELETE")).status).toBe(404);
  expect(await env.ENRICHMENT_IMAGES.head(key)).toBeNull();
});

it("scheduled maintenance discovers legacy orphans and a put whose request died", async () => {
  const id=await create();const keep=await create();
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
  // Simulates the durable storage state left if the isolate dies after a late put.
  await env.ENRICHMENT_IMAGES.put(keyFor(id),"late");
  await env.ENRICHMENT_IMAGES.put(keyFor(99999),"legacy orphan");
  await env.ENRICHMENT_IMAGES.put(keyFor(keep),"keep");
  await env.ENRICHMENT_IMAGES.put("unrelated/keep","keep");
  const controller={cron:"*/5 * * * *",scheduledTime:Date.now(),noRetry(){}} as ScheduledController;
  await worker.scheduled(controller,bindings());
  await worker.scheduled(controller,bindings());
  // Known tombstones are revisited even if a late write followed a successful purge.
  await env.DB.prepare("UPDATE privacy_deletions SET next_cleanup_at='2000-01-01'").run();
  await worker.scheduled(controller,bindings());
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(id))).toBeNull();
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(99999))).toBeNull();
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(keep))).not.toBeNull();
  expect(await env.ENRICHMENT_IMAGES.head("unrelated/keep")).not.toBeNull();
});

it("bounds each deletion request and continues a large prefix on retry", async () => {
  const id=await create();
  for(let base=0;base<405;base+=50) await Promise.all(Array.from({length:Math.min(50,405-base)},(_,i)=>
    env.ENRICHMENT_IMAGES.put(`enrichment/${id}/${String(base+i).padStart(5,"0")}`,"history")));
  expect((await request(`links/${id}`,"DELETE")).status).toBe(503);
  expect((await env.ENRICHMENT_IMAGES.list({prefix:`enrichment/${id}/`})).objects.length).toBeGreaterThan(0);
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
  expect((await env.ENRICHMENT_IMAGES.list({prefix:`enrichment/${id}/`})).objects).toHaveLength(0);
// Includes 405 real R2 fixture writes under parallel test load. The assertions
// above check bounded deletion/retry semantics, not a 5-second latency SLA.
}, 15000);

it("atomically deletes populated private tables, references, budgets and cached visibility", async () => {
  const id=await create();
  async function insert(table:string, values:Record<string,string|number>) {
    const keys=Object.keys(values);
    return env.DB.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(()=>"?").join(",")})`)
      .bind(...keys.map(k=>values[k])).run();
  }
  await insert("enrichment_sources",{link_id:id,url:"https://example.com",original_text:"private",payload:"{}",fetched_at:"t"});
  const snapshot=await insert("evidence_snapshots",{link_id:id,content_revision:1,content_hash:"hash",payload:"{}",created_at:"t"});
  const snapshotID=Number(snapshot.meta.last_row_id);
  const run=await insert("classification_runs",{link_id:id,content_revision:1,spec_id:"s",spec_hash:"h",target_generation:0,requested_model:"m",policy_version:"p",answers:"{}",operation_key:"run",created_at:"t",evidence_snapshot_id:snapshotID});
  await insert("classification_decisions",{link_id:id,run_id:Number(run.meta.last_row_id),content_revision:1,policy_version:"p",policy:"{}",automatic:"{}",operation_key:"decision",created_at:"t"});
  await insert("curation_overrides",{link_id:id,field:"topics",term:"llm",action:"accept",source:"human",revision:1,operation_key:"human",created_at:"t"});
  await insert("curation_events",{link_id:id,kind:"why",payload:'{"why":"private"}',revision:1,operation_key:"event",created_at:"t"});
  await insert("current_projections",{link_id:id,content_revision:1,effective:"{}",updated_at:"t"});
  await insert("entity_states",{link_id:id,entities:'["private entity"]',updated_at:"t"});
  await insert("entity_operations",{link_id:id,operation_key:"entity",request_hash:"h",evidence_snapshot_id:snapshotID,content_revision:1,content_hash:"h",payload:"{}",outcome:"completed",created_at:"t"});
  await insert("evidence_requests",{id:"request",link_id:id,content_revision:1,scope:"external",dedupe_key:"dedupe",created_at:"t",evidence_snapshot_id:snapshotID});
  await insert("link_selections_v2",{link_id:id,taxonomy_version:"v",revised_at:"t"});
  await insert("classification_operations",{link_id:id,operation_key:"complete",payload_hash:"h",status:"completed",response:"{}",created_at:"t"});
  await insert("legacy_curation_history",{link_id:id,payload:"{}",revision:1,provenance:"legacy_unknown",created_at:"t"});
  await insert("budget_ledger",{link_id:id,scope:"evidence",operation_key:"budget",created_at:"t"});
  await insert("budget_ledger",{scope:"batch",operation_key:"global-budget",created_at:"t"});
  const tables=["enrichment_sources","classification_jobs","evidence_snapshots","classification_runs","classification_decisions","curation_overrides","curation_events","current_projections","entity_states","entity_operations","evidence_requests","link_selections_v2","classification_operations","legacy_curation_history","budget_ledger"];
  const schema=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_*'").all<{name:string}>();
  const linked:string[]=[];
  for(const {name} of schema.results) {
    const fields=await env.DB.prepare(`PRAGMA table_info(${name})`).all<{name:string}>();
    if(name!=="privacy_deletions" && fields.results.some(f=>f.name==="link_id")) linked.push(name);
  }
  expect(linked.sort()).toEqual([...tables].sort());
  for(const table of tables) expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE link_id=?`).bind(id).first("n"),table).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_decision_runs").first("n")).toBe(1);
  const before=await request(`links/${id}`);expect(before.status).toBe(200);expect(before.headers.get("Cache-Control")).toBe("private, no-store");
  await request("links");
  const generation=await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>("value");
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
  for(const table of tables) expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE link_id=?`).bind(id).first("n"),table).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM classification_decision_runs").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE link_id IS NULL").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first<number>("value")).toBeGreaterThan(generation!);
  expect((await request(`links/${id}`)).status).toBe(404);
  expect(JSON.stringify(await (await request("links")).json())).not.toContain("synthetic private note");
  await expect(insert("budget_ledger",{link_id:id,scope:"evidence",operation_key:"late",created_at:"t"})).rejects.toThrow("budget_link_missing");
});


it("a failed D1 transaction preserves the link, budget, image and cache generation",async()=>{
  const id=await create();await env.ENRICHMENT_IMAGES.put(keyFor(id),"keep");
  const generation=await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first("value");
  await env.DB.prepare("CREATE TRIGGER stop_delete BEFORE DELETE ON links BEGIN SELECT RAISE(ABORT,'injected_transaction_failure'); END").run();
  await expect(request(`links/${id}`,"DELETE")).rejects.toThrow("injected_transaction_failure");
  expect(await env.DB.prepare("SELECT id FROM links WHERE id=?").bind(id).first()).not.toBeNull();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM privacy_deletions").first("n")).toBe(0);
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(id))).not.toBeNull();
  expect(await env.DB.prepare("SELECT value FROM cache_metadata WHERE key='links_generation'").first("value")).toBe(generation);
});

it("rechecks deletion after R2 get before returning bytes or 304",async()=>{
  const id=await create();await env.ENRICHMENT_IMAGES.put(keyFor(id),"private");
  const e=bindings();e.ENRICHMENT_IMAGES=bucket({get:async(...args:Parameters<R2Bucket["get"]>)=>{
    const object=await env.ENRICHMENT_IMAGES.get(...args);
    expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
    return object;
  }});
  expect((await request(`images/${keyFor(id)}`,"GET",undefined,"app",e)).status).toBe(404);
});

it("migration repairs old orphan budgets while retaining live and global budgets",async()=>{
  await reset();
  const before=env.TEST_MIGRATIONS.findIndex(m=>m.name.startsWith("0026_"));
  expect(before).toBeGreaterThan(0);
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,before));
  const id=await create();
  for(const [key,link] of [["live",id],["orphan",99999],["global",null]] as const)
    await env.DB.prepare("INSERT INTO budget_ledger(scope,link_id,operation_key,created_at) VALUES ('classify',?,?, 't')").bind(link,key).run();
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  const rows=await env.DB.prepare("SELECT operation_key FROM budget_ledger ORDER BY operation_key").all<{operation_key:string}>();
  expect(rows.results.map(r=>r.operation_key)).toEqual(["global","live"]);
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
});


it("an orphan receipt cannot delete images of a subsequently created live ID",async()=>{
  await env.ENRICHMENT_IMAGES.put(keyFor(1),"legacy orphan");
  const controller={cron:"*/5 * * * *",scheduledTime:Date.now(),noRetry(){}} as ScheduledController;
  await worker.scheduled(controller,bindings());
  await worker.scheduled(controller,bindings());
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(1))).toBeNull();
  const id=await create();expect(id).toBe(1);
  await env.ENRICHMENT_IMAGES.put(keyFor(id),"new live image");
  await env.DB.prepare("UPDATE privacy_deletions SET next_cleanup_at='2000-01-01'").run();
  await worker.scheduled(controller,bindings());
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(id))).not.toBeNull();
  expect((await request(`links/${id}`,"DELETE")).status).toBe(204);
  expect(await env.ENRICHMENT_IMAGES.head(keyFor(id))).toBeNull();
});
