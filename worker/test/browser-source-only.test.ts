import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
function call(path: string, body?: unknown, internal = true) {
  return worker.fetch(new Request(`https://test/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${internal ? "internal" : "app"}`, "Content-Type": "application/json",
      "X-Cairn-Provider-Attempt-Ledger": "1", "X-Cairn-Source-Lease-Admission": "1",
      "X-Cairn-Source-Component-Gate": "1", "X-Cairn-Source-Stage-Pause": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), { ...env, CAIRN_API_TOKEN: "app", CAIRN_ENRICHER_TOKEN: "internal" });
}
const url = "https://x.com/fixture/status/123";
async function saveURL() {
  const saved = await call("links", {url, note:"保留个人备注"}, false);
  expect(saved.status).toBe(201);
  return (await saved.json() as {id:number}).id;
}

it("leaves URL-only saves unclaimed with zero attempts and shows a capture instruction", async () => {
  const id = await saveURL();
  for (let i=0;i<3;i++) {
    expect(await (await call("enrichment/source-claimable")).json()).toEqual({claimable:false});
    expect((await call("enrichment/jobs/claim",{})).status).toBe(204);
  }
  expect((await call(`enrichment/jobs/${id}/claim`,{})).status).toBe(409);
  expect((await call(`enrichment/jobs/${id}/enqueue`,{operation_key:"url-only-retry"})).status).toBe(409);
  for (const path of [`enrichment/jobs/${id}`, "enrichment/jobs?view=summary"]) {
    const result:any=await (await call(path)).json();
    expect((result.items?.[0] ?? result).error).toBe("capture_required");
  }
  expect(await env.DB.prepare("SELECT original_text,enrichment_attempts,enrichment_lease_token FROM links WHERE id=?").bind(id).first())
    .toEqual({original_text:null,enrichment_attempts:0,enrichment_lease_token:null});
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_attempts").first("n")).toBe(0);
});

it("allows the browser capture to release the same saved bookmark into reading", async () => {
  const id = await saveURL();
  const text = "# 已采集正文\n\n这是浏览器实际采集的正文，包含完整段落和相关链接 https://example.com/reference 。";
  const captured = await call("captures", {url, note:"", client_id:crypto.randomUUID(), capture:{title:"采集标题", language:"zh", text, images:[]}}, false);
  expect(captured.status).toBe(201);
  expect(await captured.json()).toMatchObject({id});
  expect(await (await call("enrichment/source-claimable")).json()).toEqual({claimable:true});
  const job=await (await call("enrichment/jobs/claim",{})).json() as {id:number;source_component:string;refresh_epoch:number;lease_token:string};
  expect(job).toMatchObject({id,source_component:"reading",refresh_epoch:0});
  expect(await (await call(`enrichment/jobs/${id}/source`)).json()).toMatchObject({original_text:text,model:"browser_capture"});
  expect(await env.DB.prepare("SELECT note FROM links WHERE id=?").bind(id).first("note")).toBe("保留个人备注");
  expect((await call(`enrichment/jobs/${id}/lease-admit`,{lease_token:job.lease_token,stage:"fetch",min_remaining_ms:210000})).status).toBe(410);
  expect((await call(`enrichment/jobs/${id}/lease-admit`,{lease_token:job.lease_token,stage:"reading",min_remaining_ms:210000})).status).toBe(200);
});

it("does not let a legacy refresh intent or source gate re-enable model retrieval", async () => {
  const id=await saveURL();
  await env.DB.prepare("UPDATE links SET original_text='historical original',refresh_epoch=4,refresh_requested_at=? WHERE id=?")
    .bind(new Date().toISOString(),id).run();
  await env.DB.prepare("UPDATE enrichment_component_gates SET state='open',retry_at='9999-01-01' WHERE component='source'").run();
  expect((await call(`enrichment/jobs/${id}/refresh-source`,{operation_key:"legacy-refresh"})).status).toBe(410);
  expect(await (await call("enrichment/jobs/claim",{})).json()).toMatchObject({id,source_component:"reading",refresh_epoch:0});
  expect(await env.DB.prepare("SELECT original_text,refresh_epoch FROM links WHERE id=?").bind(id).first())
    .toEqual({original_text:"historical original",refresh_epoch:4});
});

it("keeps an unresolved historical fetch receipt charged while waiting for capture", async () => {
  const id=await saveURL();
  await env.DB.prepare(`INSERT INTO enrichment_provider_attempts(operation_key,link_id,lease_hash,content_revision,stage,variant,attempt_number,request_hash,reservation_hash,model,created_at)
    SELECT ?,id,?,content_revision,'fetch','fetch_thread',1,?,?,'historical',? FROM links WHERE id=?`)
    .bind("a".repeat(64),"b".repeat(64),"c".repeat(64),"d".repeat(64),new Date().toISOString(),id).run();
  await env.DB.prepare("UPDATE links SET enrichment_status='failed',enrichment_error='provider_result_unknown' WHERE id=?").bind(id).run();
  expect((await call("enrichment/jobs/claim",{})).status).toBe(204);
  expect(await env.DB.prepare("SELECT enrichment_paid_uncertain FROM links WHERE id=?").bind(id).first("enrichment_paid_uncertain")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM enrichment_provider_attempts").first("n")).toBe(1);
  expect(await (await call(`enrichment/jobs/${id}`)).json()).toMatchObject({error:"capture_required",paid_call_unresolved:true});
});
