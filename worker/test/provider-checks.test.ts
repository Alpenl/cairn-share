import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetObservabilityCacheForTest } from "../src/observability";
const scope="a".repeat(64);
let now=Date.now();
beforeEach(async()=>{await reset();await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);resetObservabilityCacheForTest();now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);});
afterEach(()=>vi.restoreAllMocks());
async function call(action:string,body:Record<string,unknown>={},token="internal"){
 const get=action==="status";
 return worker.fetch(new Request(`https://test/api/enrichment/provider-checks/${action}${get?"?scope="+(body.scope??scope):""}`,{
 method:get?"GET":"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
 ...(!get?{body:JSON.stringify({scope,...body})}:{})}),{...env,CAIRN_ENRICHER_TOKEN:"internal",CAIRN_API_TOKEN:"app"});
}
const data=async(action:string,body:Record<string,unknown>={})=>(await call(action,body)).json() as Promise<Record<string,any>>;
it("persists success for 24h, isolates configurations, and never grants a second concurrent owner",async()=>{
 expect((await call("claim",{},"app")).status).toBe(401);
 const jobs=await Promise.all([data("claim"),data("claim"),data("claim")]);
 expect(jobs.filter(j=>j.granted)).toHaveLength(1);
 const token=jobs.find(j=>j.granted)!.lease_token;
 expect((await call("finish",{lease_token:"wrong",success:true})).status).toBe(409);
 expect(await data("finish",{lease_token:token,success:true})).toMatchObject({state:"healthy",failures:0,valid_until:now+86_400_000});
 expect(await data("claim")).toMatchObject({state:"healthy",granted:false});
 expect(await data("claim",{scope:"b".repeat(64)})).toMatchObject({granted:true});
 now+=86_400_001;
 expect(await data("claim")).toMatchObject({granted:true});
});
it("backs off across restarts and manual recovery only advances one probe",async()=>{
 let job=await data("claim");
 expect(await data("recover")).toMatchObject({accepted:false,state:"checking"});
 const fail=await data("finish",{lease_token:job.lease_token,success:false,reason:"timeout"});
 expect(fail).toMatchObject({state:"waiting",failures:1,next_check_at:now+300_000});
 expect(await data("claim")).toMatchObject({granted:false});
 expect(await data("recover")).toMatchObject({accepted:false});
 now+=60_001;
 const requests=await Promise.all([data("recover"),data("recover"),data("recover")]);
 expect(requests.filter(r=>r.accepted)).toHaveLength(1);
 expect(requests.find(r=>r.accepted)!.state).toBe("pending");
 job=await data("claim");expect(job.granted).toBe(true);
 expect(await data("finish",{lease_token:job.lease_token,success:false,reason:"unavailable"})).toMatchObject({failures:2,next_check_at:now+600_000});
 const row=await env.DB.prepare("SELECT manual_requests FROM provider_checks WHERE scope=?").bind(scope).first();
 expect(row).toEqual({manual_requests:1});
 expect((await env.DB.prepare("SELECT count(*) n FROM enrichment_provider_attempts").first())?.n).toBe(0);
});
it("caps backoff, fences expired owners and preserves total-budget exhaustion",async()=>{
 let job=await data("claim");now+=900_001;
 expect((await call("finish",{lease_token:job.lease_token,success:true})).status).toBe(409);
 job=await data("claim");expect(job.granted).toBe(true);
 await env.DB.prepare("UPDATE provider_checks SET failures=20 WHERE scope=?").bind(scope).run();
 expect(await data("finish",{lease_token:job.lease_token,success:false,reason:"rate_limited"})).toMatchObject({next_check_at:now+3_600_000});
 now+=3_600_001;job=await data("claim");
 expect(await data("finish",{lease_token:job.lease_token,success:false,reason:"budget_exhausted"})).toMatchObject({next_check_at:Date.parse(new Date(now).toISOString().slice(0,10))+86_400_000});
 expect((await call("finish",{lease_token:"x",success:false,reason:"secret"})).status).toBe(400);
});

it("successful recovery advances open stage cooldowns without closing or stealing probes",async()=>{
 const job=await data("claim");
 const future=new Date(now+600_000).toISOString();
 await env.DB.prepare("UPDATE enrichment_component_gates SET state='open',retry_at=?,failures=3 WHERE component='source'").bind(future).run();
 await env.DB.prepare("UPDATE enrichment_component_gates SET state='probing',probe_token='existing',probe_until=? WHERE component='reading'").bind(future).run();
 expect((await call("finish",{lease_token:job.lease_token,success:true})).status).toBe(200);
 expect(await env.DB.prepare("SELECT state,retry_at,failures FROM enrichment_component_gates WHERE component='source'").first()).toEqual({state:"open",retry_at:new Date(now).toISOString(),failures:3});
 expect(await env.DB.prepare("SELECT state,probe_token,probe_until FROM enrichment_component_gates WHERE component='reading'").first()).toEqual({state:"probing",probe_token:"existing",probe_until:future});
});
